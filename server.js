const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');


const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'playlists.json');

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://hitstrr-server-production.up.railway.app/callback';
// Where to send the user after auth — the game's URL
const GAME_URL = process.env.GAME_URL || 'https://flanders-pixel.github.io/hitstrr/';

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.warn('WARNING: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET not set.');
}

app.use(cors({
  origin: ['https://flanders-pixel.github.io', 'http://localhost:3000', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors()); // handle preflight
app.use(express.json());

// ── Storage ───────────────────────────────────────────────────────────────────
function loadPlaylists() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}
function savePlaylists(playlists) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(playlists, null, 2));
}

// ── Pending playlist adds (in-memory, keyed by state param) ──────────────────
// state -> { playlistUrl, emoji, timestamp }
const pendingAdds = new Map();

// Clean up old pending adds every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pendingAdds) {
    if (v.timestamp < cutoff) pendingAdds.delete(k);
  }
}, 10 * 60 * 1000);

// ── App-level Spotify token (for non-restricted playlists) ────────────────────
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

// ── User OAuth token exchange ─────────────────────────────────────────────────
async function getUserToken(code) {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  console.log('Token exchange: redirect_uri =', REDIRECT_URI);
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const responseText = await res.text();
  console.log('Token exchange response:', res.status, responseText.substring(0, 200));
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${responseText}`);
  }
  const data = JSON.parse(responseText);
  console.log('Got user token, scope:', data.scope);
  return data.access_token;
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
  const lower = albumName.toLowerCase();
  return REMASTER_KEYWORDS.some(kw => lower.includes(kw));
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

// ── Fetch playlist tracks with a given token ──────────────────────────────────
async function fetchPlaylistWithToken(playlistId, token) {
  console.log('Fetching playlist', playlistId, 'token starts with:', token.substring(0,10));
  const metaRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,description`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const metaText = await metaRes.text();
  console.log('Playlist meta response:', metaRes.status, metaText.substring(0, 200));
  if (!metaRes.ok) throw new Error(`Playlist not found or not accessible (${metaRes.status}): ${metaText}`);
  const meta = JSON.parse(metaText);

  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(id,name,artists,album(name,release_date)))`;
  while (url) {
    console.log('Fetching tracks page:', url.substring(0,80));
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const resText = await res.text();
    console.log('Tracks response:', res.status, resText.substring(0,150));
    if (!res.ok) throw new Error(`Failed to fetch tracks: ${res.status}: ${resText.substring(0,200)}`);
    const data = JSON.parse(resText);
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
    url = data.next || null;
  }
  return { name: meta.name, tracks };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Hitstrr API' }));

app.get('/playlists', (req, res) => res.json(loadPlaylists()));

// Step 1: Client calls this to get the Spotify auth URL
// Returns either { authUrl } (needs login) or adds directly if app token works
app.post('/playlists/prepare', async (req, res) => {
  const { url, emoji } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const playlistId = extractPlaylistId(url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });

  // Check duplicate
  const existing = loadPlaylists();
  if (existing.find(p => p.spotifyId === playlistId)) {
    return res.status(409).json({ error: 'This playlist is already in the game' });
  }

  // Try app token first
  try {
    const token = await getAppToken();
    const { name, tracks } = await fetchPlaylistWithToken(playlistId, token);
    if (!tracks.length) return res.status(400).json({ error: 'Playlist has no playable tracks' });
    const playlist = {
      spotifyId: playlistId, name, emoji: emoji || '🎵',
      tracks, flaggedCount: tracks.filter(t => t.yearWarning).length,
      addedAt: new Date().toISOString(),
    };
    savePlaylists([...existing, playlist]);
    return res.json({ success: true, playlist, method: 'app' });
  } catch (e) {
    // App token failed (probably 403) — need user auth
    if (!e.message.includes('403')) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Generate state token and store pending add
  const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
  pendingAdds.set(state, { playlistId, emoji: emoji || '🎵', timestamp: Date.now() });

  // Build Spotify auth URL — scope: playlist-read-private covers all public+private playlists
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'playlist-read-private playlist-read-collaborative',
    state,
    show_dialog: 'false', // don't show dialog if already authorized
  });
  const authUrl = `https://accounts.spotify.com/authorize?${params}`;
  res.json({ needsAuth: true, authUrl });
});

// Step 2: Spotify redirects here after user login
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${GAME_URL}?addError=${encodeURIComponent('Spotify login cancelled')}`);
  }

  const pending = pendingAdds.get(state);
  if (!pending) {
    return res.redirect(`${GAME_URL}?addError=${encodeURIComponent('Session expired — please try again')}`);
  }
  pendingAdds.delete(state);

  try {
    const userToken = await getUserToken(code);
    const { name, tracks } = await fetchPlaylistWithToken(pending.playlistId, userToken);
    if (!tracks.length) {
      return res.redirect(`${GAME_URL}?addError=${encodeURIComponent('Playlist has no playable tracks')}`);
    }
    const playlist = {
      spotifyId: pending.playlistId, name, emoji: pending.emoji,
      tracks, flaggedCount: tracks.filter(t => t.yearWarning).length,
      addedAt: new Date().toISOString(),
    };
    const existing = loadPlaylists();
    if (!existing.find(p => p.spotifyId === pending.playlistId)) {
      savePlaylists([...existing, playlist]);
    }
    res.redirect(`${GAME_URL}?addSuccess=${encodeURIComponent(name)}`);
  } catch (e) {
    res.redirect(`${GAME_URL}?addError=${encodeURIComponent(e.message)}`);
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

// Delete
app.delete('/playlists/:id', (req, res) => {
  const playlists = loadPlaylists();
  const filtered = playlists.filter(p => p.spotifyId !== req.params.id);
  if (filtered.length === playlists.length) return res.status(404).json({ error: 'Not found' });
  savePlaylists(filtered);
  res.json({ success: true });
});

// ── Keep-alive: ping self every 10 minutes to prevent Railway sleeping ───────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/`
  : null;

if (SELF_URL) {
  setInterval(async () => {
    try { await fetch(SELF_URL); }
    catch (e) { /* ignore */ }
  }, 10 * 60 * 1000); // every 10 minutes
}

app.listen(PORT, '0.0.0.0', () => console.log(`Hitstrr server running on port ${PORT}`));
