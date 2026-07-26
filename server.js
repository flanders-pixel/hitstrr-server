const express = require('express');
const QRCode = require('qrcode');
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


// ── MusicBrainz original year lookup ─────────────────────────────────────────
let mbLastCall = 0;
async function mbThrottle() {
  const now = Date.now();
  const wait = 1100 - (now - mbLastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  mbLastCall = Date.now();
}

async function lookupOriginalYear(title, artist) {
  try {
    await mbThrottle();
    const cleanTitle = title
      .replace(/\s*[-\u2013\u2014]\s*(stereo|mono|remaster.*|single.*|album.*|live.*|remix.*|radio.*|edit.*)$/i, '')
      .replace(/\s*[\(\[][^\)\]]*(remaster|version|edit|mix|live|mono|stereo)[^\)\]]*[\)\]]\s*$/i, '')
      .trim();
    const cleanArtist = artist.split(' & ')[0].trim();
    const query = encodeURIComponent('"' + cleanTitle + '" AND artist:"' + cleanArtist + '"');
    const url = 'https://musicbrainz.org/ws/2/recording/?query=' + query + '&limit=8&fmt=json';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Hitstrr/1.0 (music timeline game)' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.recordings || !data.recordings.length) return null;
    let earliest = null;
    for (const rec of data.recordings) {
      // Only trust strong matches — fuzzy hits on similarly-named songs
      // can otherwise drag the year to something unrelated.
      if ((rec.score || 0) < 90) continue;
      const recDate = parseInt((rec['first-release-date'] || '').substring(0, 4));
      if (recDate > 1900 && recDate <= new Date().getFullYear()) {
        if (!earliest || recDate < earliest) earliest = recDate;
      }
      if (!rec.releases) continue;
      for (const release of rec.releases) {
        const year = parseInt((release.date || '').substring(0, 4));
        if (year > 1900 && year <= new Date().getFullYear()) {
          if (!earliest || year < earliest) earliest = year;
        }
      }
    }
    return earliest;
  } catch (e) {
    return null;
  }
}

async function autoCorrectYears(tracks, checkAll) {
  const targets = checkAll ? tracks : tracks.filter(t => t.yearWarning);
  if (!targets.length) return 0;
  console.log((checkAll ? 'Verifying ' : 'Auto-correcting ') + targets.length + ' tracks via MusicBrainz...');
  let corrected = 0;
  for (const track of targets) {
    const mbYear = await lookupOriginalYear(track.title, track.artist);
    if (mbYear && mbYear < track.year) {
      console.log('  ' + track.title + ': ' + track.year + ' -> ' + mbYear);
      track.year = mbYear;
      track.yearWarning = null;
      track.yearCorrected = true;
      corrected++;
    } else if (mbYear && mbYear === track.year) {
      track.yearWarning = null;
      track.yearCorrected = true;
    }
  }
  console.log('  Done: ' + corrected + ' corrected.');
  return corrected;
}

// Full MusicBrainz verification of a stored playlist, run in the background.
// Spotify reports the *album's* release date, so tracks on reissues and
// compilations with innocent names ("Rare Cult") slip past the keyword
// heuristic. This checks every track and persists any corrections by
// re-loading storage at write time to avoid clobbering concurrent changes.
let verifyQueue = Promise.resolve();
function scheduleFullYearVerify(spotifyId) {
  verifyQueue = verifyQueue.then(async () => {
    const pl = loadPlaylists().find(p => p.spotifyId === spotifyId);
    if (!pl) return;
    console.log('Background year verify: ' + pl.name + ' (' + pl.tracks.length + ' tracks)');
    const copies = pl.tracks.map(t => ({ ...t }));
    await autoCorrectYears(copies, true);
    const byId = {};
    copies.forEach(t => { byId[t.id] = t; });
    const fresh = loadPlaylists();
    const target = fresh.find(p => p.spotifyId === spotifyId);
    if (!target) return;
    let changed = 0;
    target.tracks.forEach(t => {
      const c = byId[t.id];
      if (c && c.year !== t.year) { t.year = c.year; t.yearWarning = c.yearWarning; t.yearCorrected = true; changed++; }
      else if (c && c.yearCorrected && !t.yearCorrected) { t.yearWarning = c.yearWarning; t.yearCorrected = true; }
    });
    target.flaggedCount = target.tracks.filter(t => t.yearWarning).length;
    target.yearsVerifiedAt = new Date().toISOString();
    savePlaylists(fresh);
    console.log('Background year verify done: ' + pl.name + ' — ' + changed + ' years corrected');
  }).catch(e => console.error('Background year verify failed:', e.message));
}

// ── QR code generation ───────────────────────────────────────────────────────
const QR_CACHE_FILE = path.join(__dirname, 'qr_cache.json');
let qrCache = {};
try { qrCache = JSON.parse(fs.readFileSync(QR_CACHE_FILE, 'utf8')); } catch(e) {}
function saveQRCache() {
  try { fs.writeFileSync(QR_CACHE_FILE, JSON.stringify(qrCache)); } catch(e) {}
}
async function generateQR(spotifyId) {
  if (qrCache[spotifyId]) return qrCache[spotifyId];
  const url = `https://open.spotify.com/track/${spotifyId}`;
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  const pathMatch = svg.match(/stroke="#000000" d="([^"]+)"/);
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (!pathMatch || !viewBox) throw new Error('QR generation failed');
  const data = { d: pathMatch[1], vb: viewBox };
  qrCache[spotifyId] = data;
  saveQRCache();
  return data;
}
async function preGenerateQRCodes(tracks) {
  for (const track of tracks) {
    if (!qrCache[track.id]) {
      try { await generateQR(track.id); } catch(e) { /* skip */ }
    }
  }
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

// Export a stored (already MusicBrainz-scanned) playlist's tracks straight into
// the frontend repo as scan-result.json, so its corrected years can be baked
// into the bundled klassiskt playlist. Uses GITHUB_TOKEN from the environment —
// the token is never sent to the browser. Trigger once, after the background
// year-verify has finished for the imported playlist.
// GET variant so it can be triggered by simply visiting a URL in a phone browser:
//   /export-to-repo-get/latest?token=ghp_xxx   (or ?name=Classical%20bangers)
app.get('/export-to-repo-get/:id', (req, res) => {
  req.body = { token: req.query.token };
  if (req.query.name) req.params.id = req.query.name;
  return exportToRepoHandler(req, res);
});

app.post('/export-to-repo/:id', async (req, res) => {
  return exportToRepoHandler(req, res);
});

async function exportToRepoHandler(req, res) {
  const token = req.body?.token || process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not set in environment' });

  const all = loadPlaylists();
  const key = decodeURIComponent(req.params.id);
  const pl = key === 'latest'
    ? all[all.length - 1]
    : all.find(p => p.spotifyId === key || p.name === key);
  if (!pl) return res.status(404).json({ error: `Playlist not found. Available: ${all.map(p => p.name).join(', ') || '(none stored)'}` });

  const repo = 'flanders-pixel/hitstrr';
  const outPath = 'scan-result.json';
  const tracks = pl.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, year: t.year }));
  const content = Buffer.from(JSON.stringify(tracks), 'utf8').toString('base64');

  try {
    let sha = null;
    const g = await fetch(`https://api.github.com/repos/${repo}/contents/${outPath}`, {
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'Hitstrr-server' }
    });
    if (g.ok) sha = (await g.json()).sha;

    const body = {
      message: `Export scanned playlist "${pl.name}" (${tracks.length} tracks) for bundle merge`,
      content,
    };
    if (sha) body.sha = sha;

    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${outPath}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'Hitstrr-server', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(500).json({ error: `GitHub push failed (${r.status}): ${errText.slice(0, 200)}` });
    }
    const result = await r.json();
    const flagged = pl.tracks.filter(t => t.yearWarning).length;
    res.json({
      success: true,
      exported: tracks.length,
      stillFlagged: flagged,
      yearsVerifiedAt: pl.yearsVerifiedAt || null,
      commit: result.commit?.sha,
      message: `Exported ${tracks.length} tracks to ${outPath}. ${flagged} still flagged. Tell Claude "exported".`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Stateless MusicBrainz year verification. Accepts { tracks: [{title,artist,year,id}] },
// runs the same original-year lookup used on import, and returns the corrected
// tracks. Touches no storage — used to bake correct composition years into the
// bundled (in-HTML) playlists. Runs synchronously; ~1.1s/track, so send in chunks.
app.post('/verify-years', async (req, res) => {
  const tracks = req.body?.tracks;
  if (!Array.isArray(tracks) || !tracks.length) {
    return res.status(400).json({ error: 'tracks array is required' });
  }
  if (tracks.length > 120) {
    return res.status(400).json({ error: 'Send at most 120 tracks per request (MusicBrainz throttle). Chunk it.' });
  }
  try {
    const copies = tracks.map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      year: parseInt(t.year) || 0,
      yearWarning: t.yearWarning || 'unverified',
    }));
    const corrected = await autoCorrectYears(copies, true);
    res.json({
      success: true,
      corrected,
      changedCount: corrected,
      tracks: copies.map(t => ({ id: t.id, title: t.title, artist: t.artist, year: t.year, yearCorrected: !!t.yearCorrected })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    await autoCorrectYears(tracks);
    const playlist = { spotifyId: playlistId, name: meta.name, emoji: emoji || '🎵', tracks, flaggedCount: tracks.filter(t => t.yearWarning).length, addedAt: new Date().toISOString() };
    savePlaylists([...existing, playlist]);
    res.json({ success: true, playlist });
    // Verify all years against MusicBrainz in the background
    scheduleFullYearVerify(playlistId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import playlist from Exportify CSV
app.post('/playlists/import-csv', async (req, res) => {
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
    const albumIdx = col('album name');

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
      const albumName = albumIdx !== -1 ? (cols[albumIdx] || '') : '';
      if (!title) continue;
      tracks.push({
        id, title: cleanTitle(title), artist, year,
        yearWarning: isLikelyRemaster(albumName)
          ? `Album "${albumName}" may be a remaster or compilation — year ${year} may not be the original release`
          : null,
      });
    }

    if (!tracks.length) return res.status(400).json({ error: 'No valid tracks found in CSV' });

    // Flag tracks with year=0 or likely wrong years before MusicBrainz check
    tracks.forEach(t => {
      if (!t.year || t.year === 0) t.yearWarning = 'Year missing';
    });

    const spotifyId = 'csv_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30) + '_' + Date.now();
    const existing = loadPlaylists();

    // Auto-correct flagged years via MusicBrainz
    await autoCorrectYears(tracks);

    const playlist = { spotifyId, name, emoji: emoji || '🎵', tracks, flaggedCount: tracks.filter(t => t.yearWarning).length, addedAt: new Date().toISOString() };
    savePlaylists([...existing, playlist]);
    res.json({ success: true, playlist });
    // Pre-generate QR codes and verify all years in background
    preGenerateQRCodes(playlist.tracks).catch(() => {});
    scheduleFullYearVerify(spotifyId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Merge an Exportify CSV into an EXISTING playlist (append + dedup by track id),
// then background-verify all years via MusicBrainz. Used to grow the classical
// playlist rather than create a separate one.
app.post('/playlists/:id/merge-csv', async (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv is required' });

  const playlists = loadPlaylists();
  const target = playlists.find(p => p.spotifyId === req.params.id);
  if (!target) return res.status(404).json({ error: 'Playlist not found' });

  try {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ error: 'CSV appears empty' });

    const header = parseCSVLine(lines[0]);
    const col = (name) => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
    const uriIdx = col('track uri');
    const titleIdx = col('track name');
    const artistIdx = col('artist name');
    const dateIdx = col('release date');
    const albumIdx = col('album name');

    if (uriIdx === -1 || titleIdx === -1) {
      return res.status(400).json({ error: 'CSV missing required columns. Please export from exportify.net' });
    }

    // Seed the dedup set with tracks ALREADY in the target playlist, so the
    // merge removes duplicates across both the existing playlist and the CSV.
    const seen = new Set(target.tracks.map(t => t.id));
    const existingCount = target.tracks.length;
    const newTracks = [];
    let dupCsvInternal = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) continue;
      const uri = cols[uriIdx] || '';
      const id = uri.replace('spotify:track:', '').trim();
      if (!id) continue;
      if (seen.has(id)) { dupCsvInternal++; continue; }
      seen.add(id);
      const title = cols[titleIdx] || '';
      const artist = (cols[artistIdx] || '').replace(/;/g, ' & ');
      const rawDate = dateIdx !== -1 ? (cols[dateIdx] || '') : '';
      const year = parseInt(rawDate.substring(0, 4)) || 0;
      const albumName = albumIdx !== -1 ? (cols[albumIdx] || '') : '';
      if (!title) continue;
      newTracks.push({
        id, title: cleanTitle(title), artist, year,
        yearWarning: isLikelyRemaster(albumName)
          ? `Album "${albumName}" may be a remaster or compilation — year ${year} may not be the original release`
          : null,
      });
    }

    newTracks.forEach(t => { if (!t.year || t.year === 0) t.yearWarning = 'Year missing'; });

    if (!newTracks.length) {
      return res.json({ success: true, added: 0, duplicatesSkipped: dupCsvInternal, total: existingCount, message: 'No new tracks — everything in the CSV was already in the playlist.' });
    }

    // Auto-correct flagged years on the NEW tracks before storing.
    await autoCorrectYears(newTracks);

    target.tracks = [...target.tracks, ...newTracks];
    target.flaggedCount = target.tracks.filter(t => t.yearWarning).length;
    target.mergedAt = new Date().toISOString();
    savePlaylists(playlists);

    res.json({
      success: true,
      added: newTracks.length,
      duplicatesSkipped: dupCsvInternal,
      total: target.tracks.length,
      playlist: target.name,
    });

    // Pre-generate QR codes for the new tracks and full-verify years in background.
    preGenerateQRCodes(newTracks).catch(() => {});
    scheduleFullYearVerify(target.spotifyId);
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

// Get QR code for a track (generated on demand)
app.get('/qr/:trackId', async (req, res) => {
  try {
    const data = await generateQR(req.params.trackId);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Delete playlist
app.delete('/playlists/:id', (req, res) => {
  const playlists = loadPlaylists();
  const filtered = playlists.filter(p => p.spotifyId !== req.params.id);
  if (filtered.length === playlists.length) return res.status(404).json({ error: 'Not found' });
  savePlaylists(filtered);
  res.json({ success: true });
});

// Re-verify all years in an existing playlist against MusicBrainz (background)
app.post('/playlists/:id/recheck-years', (req, res) => {
  const pl = loadPlaylists().find(p => p.spotifyId === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  scheduleFullYearVerify(pl.spotifyId);
  res.json({ success: true, message: 'Verifying ' + pl.tracks.length + ' tracks in background (~' + Math.ceil(pl.tracks.length * 1.2 / 60) + ' min)' });
});

// Manually correct a single track's year (fallback when MusicBrainz misses)
app.patch('/playlists/:id/tracks/:trackId', (req, res) => {
  const year = parseInt(req.body?.year);
  if (!year || year < 1900 || year > new Date().getFullYear()) {
    return res.status(400).json({ error: 'Valid year is required' });
  }
  const playlists = loadPlaylists();
  const pl = playlists.find(p => p.spotifyId === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const track = pl.tracks.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const oldYear = track.year;
  track.year = year;
  track.yearWarning = null;
  track.yearCorrected = true;
  pl.flaggedCount = pl.tracks.filter(t => t.yearWarning).length;
  savePlaylists(playlists);
  console.log('Manual year fix: ' + track.title + ' ' + oldYear + ' -> ' + year);
  res.json({ success: true, track });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Hitstrr server running on port ${PORT}`));
