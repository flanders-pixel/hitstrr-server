const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
// Railway (and most hosts) run the app behind a proxy, so the client IP is in
// X-Forwarded-For. Trust one proxy hop so the rate limiter keys on the real IP.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'playlists.json');

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.warn('WARNING: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET not set. URL-based playlist fetching will not work.');
}

app.use(cors({
  origin: ['https://flanders-pixel.github.io', 'http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:8080'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json({ limit: '5mb' })); // CSV files can be large

// ── Storage ───────────────────────────────────────────────────────────────────
function loadPlaylists() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}
function savePlaylists(playlists) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(playlists, null, 2));
}

// ── Spotify app-token (for unrestricted public playlists) ─────────────────────
let appToken = null;
let appTokenExpiry = 0;

async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiry) return appToken;
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json();
  appToken = data.access_token;
  appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return appToken;
}

// ── Year detection ────────────────────────────────────────────────────────────
const REMASTER_KEYWORDS = [
  'remaster','remastered','reissue','reissued','re-issue',
  'greatest hits','greatest hit','best of','best-of',
  'collection','anthology','the singles','hits',
  'anniversary','deluxe','deluxe edition','expanded',
  'bonus','legacy edition','platinum edition','gold edition',
  'special edition','complete recordings','essential','ultimate',
  'definitive collection','the very best',
  'live','live at','live in','live from','unplugged','acoustic',
  'box set','boxset',
];
const TITLE_SUFFIXES = [
  /\s*[-\u2013\u2014]\s*\d{4}\s+remaster(ed)?$/i,
  /\s*[-\u2013\u2014]\s*remaster(ed)?(\s+\d{4})?$/i,
  /\s*\(.*remaster.*\)$/i,
  /\s*\[.*remaster.*\]$/i,
  /\s*[-\u2013\u2014]\s*single (version|edit)$/i,
  /\s*\(single (version|edit)\)$/i,
];
function isLikelyRemaster(albumName) {
  if (!albumName) return false;
  return REMASTER_KEYWORDS.some(kw => albumName.toLowerCase().includes(kw));
}
function cleanTitle(title) {
  let t = title;
  for (const re of TITLE_SUFFIXES) t = t.replace(re, '');
  return t.trim();
}
function extractPlaylistId(input) {
  const urlMatch = input.match(/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9]+$/.test(input.trim())) return input.trim();
  return null;
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// POST /playlists is the only endpoint that spends our Spotify quota (and it
// amplifies: one request paginates the whole playlist). Cap it so a bad actor
// who finds the site can't run the Spotify app into rate limits / suspension.
const addPlaylistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 40,                  // 20 playlist adds per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many playlists added from this IP. Try again later.' },
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve the frontend (index.html lives alongside server.js)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Hitstrr API' }));

app.get('/playlists', (req, res) => res.json(loadPlaylists()));

// Add playlist by Spotify URL
app.post('/playlists', addPlaylistLimiter, async (req, res) => {
  const { url, emoji } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const playlistId = extractPlaylistId(url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });

  const existing = loadPlaylists();
  if (existing.find(p => p.spotifyId === playlistId)) {
    return res.status(409).json({ error: 'This playlist is already in the game' });
  }

  try {
    const token = await getAppToken();
    const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!metaRes.ok) throw new Error(`Playlist not found or restricted (${metaRes.status}). Try CSV import instead.`);
    const meta = await metaRes.json();

    const tracks = [];
    let trackUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
    while (trackUrl) {
      const r = await fetch(trackUrl, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Could not fetch tracks (${r.status}). This playlist may be restricted — try CSV import instead.`);
      const data = await r.json();
      for (const item of data.items) {
        const track = item.track;
        if (!track || !track.id) continue;
        const albumName = track.album?.name || '';
        const year = parseInt((track.album?.release_date || '').substring(0, 4)) || 0;
        tracks.push({
          id: track.id,
          title: cleanTitle(track.name),
          artist: track.artists.map(a => a.name).join(' & '),
          year,
          yearWarning: isLikelyRemaster(albumName)
            ? `Album "${albumName}" may be a remaster or compilation — year ${year} may not be the original release`
            : null,
        });
      }
      trackUrl = data.next || null;
    }

    if (!tracks.length) return res.status(400).json({ error: 'Playlist has no playable tracks' });
    const playlist = { spotifyId: playlistId, name: meta.name, emoji: emoji || '🎵', tracks, flaggedCount: tracks.filter(t => t.yearWarning).length, addedAt: new Date().toISOString() };
    savePlaylists([...existing, playlist]);
    res.json({ success: true, playlist });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import playlist from Exportify CSV
app.post('/playlists/import-csv', (req, res) => {
  const { csv, name, emoji } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv is required' });
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ error: 'CSV appears empty' });

    const header = parseCSVLine(lines[0]);
    const col = (name) => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
    const uriIdx = col('track uri');
    const titleIdx = col('track name');
    const artistIdx = col('artist name');
    const dateIdx = col('release date');

    if (uriIdx === -1 || titleIdx === -1) {
      return res.status(400).json({ error: 'CSV missing required columns. Please export from exportify.net' });
    }

    const tracks = [];
    const seen = new Set();
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) continue;
      const uri = cols[uriIdx] || '';
      const id = uri.replace('spotify:track:', '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = cols[titleIdx] || '';
      const artist = (cols[artistIdx] || '').replace(/;/g, ' & ');
      const rawDate = dateIdx !== -1 ? (cols[dateIdx] || '') : '';
      const year = parseInt(rawDate.substring(0, 4)) || 0;
      if (!title) continue;
      tracks.push({ id, title: cleanTitle(title), artist, year, yearWarning: null });
    }

    if (!tracks.length) return res.status(400).json({ error: 'No valid tracks found in CSV' });

    const spotifyId = 'csv_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30) + '_' + Date.now();
    const existing = loadPlaylists();
    const playlist = { spotifyId, name, emoji: emoji || '🎵', tracks, flaggedCount: 0, addedAt: new Date().toISOString() };
    savePlaylists([...existing, playlist]);
    res.json({ success: true, playlist });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get flagged tracks
app.get('/playlists/:id/flags', (req, res) => {
  const pl = loadPlaylists().find(p => p.spotifyId === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  res.json({ playlist: pl.name, flaggedCount: pl.tracks.filter(t => t.yearWarning).length, tracks: pl.tracks.filter(t => t.yearWarning) });
});

// Correct a track year
app.patch('/playlists/:id/tracks/:trackId', (req, res) => {
  const { year } = req.body;
  if (!year || isNaN(year)) return res.status(400).json({ error: 'Valid year required' });
  const playlists = loadPlaylists();
  const plIdx = playlists.findIndex(p => p.spotifyId === req.params.id);
  if (plIdx === -1) return res.status(404).json({ error: 'Playlist not found' });
  const tIdx = playlists[plIdx].tracks.findIndex(t => t.id === req.params.trackId);
  if (tIdx === -1) return res.status(404).json({ error: 'Track not found' });
  playlists[plIdx].tracks[tIdx].year = parseInt(year);
  playlists[plIdx].tracks[tIdx].yearWarning = null;
  playlists[plIdx].tracks[tIdx].yearCorrected = true;
  savePlaylists(playlists);
  res.json(playlists[plIdx].tracks[tIdx]);
});

// Update emoji
app.patch('/playlists/:id', (req, res) => {
  const { emoji } = req.body;
  const playlists = loadPlaylists();
  const idx = playlists.findIndex(p => p.spotifyId === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (emoji) playlists[idx].emoji = emoji;
  savePlaylists(playlists);
  res.json(playlists[idx]);
});

// Delete playlist
app.delete('/playlists/:id', (req, res) => {
  const playlists = loadPlaylists();
  const filtered = playlists.filter(p => p.spotifyId !== req.params.id);
  if (filtered.length === playlists.length) return res.status(404).json({ error: 'Not found' });
  savePlaylists(filtered);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Hitstrr server running on port ${PORT}`));
