import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, updateConfig, ROOT, SONGS_DIR } from './config.js';
import { Store } from './store.js';
import { Engine } from './loop.js';
import { CoverEngine, COVERS_DIR } from './covers.js';
import { logEvent, getLogs, clearLogs } from './logger.js';

const store = new Store();
const engine = new Engine(store, config);
const covers = new CoverEngine(store, config, engine);
covers.start();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Dashboard API request logging ("http" category). SSE and the log poller
// itself are excluded to keep the stream readable.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || req.path === '/api/events' || req.path.startsWith('/api/logs')) {
    return next();
  }
  const t0 = Date.now();
  res.on('finish', () => {
    logEvent(
      'http',
      `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t0}ms)`,
      req.method === 'GET' || req.method === 'DELETE' ? undefined : req.body,
    );
  });
  next();
});

// ---- state ----

app.get('/api/state', (req, res) => res.json(store.state));

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = () => res.write(`data: ${JSON.stringify(store.state)}\n\n`);
  send();
  store.on('change', send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    store.off('change', send);
  });
});

// ---- logs (settings page viewer) ----

app.get('/api/logs', (req, res) => {
  const entries = getLogs(Number(req.query.since ?? 0));
  res.json({ entries, latest: entries.length ? entries[entries.length - 1].id : Number(req.query.since ?? 0) });
});

app.post('/api/logs/clear', (req, res) => {
  clearLogs();
  res.json({ ok: true });
});

// ---- configuration (settings page) ----

// Values that only take effect after a server restart.
const RESTART_PATHS = ['server.port', 'storage.songsDir'];

app.get('/api/config', (req, res) => res.json(config));

// Body: { "lmstudio.temperature": 0.8, "llamacpp.jlens.layerRange.0": 10, ... }
// Changes mutate the live config (hot-apply) and are persisted to the
// database as overrides — config.json stays untouched as the defaults file.
app.patch('/api/config', (req, res) => {
  const changes = req.body ?? {};
  const restartRequired = [];
  try {
    updateConfig(changes);
    for (const dotted of Object.keys(changes)) {
      if (RESTART_PATHS.some((p) => dotted === p || dotted.startsWith(`${p}.`))) {
        restartRequired.push(dotted);
      }
    }
  } catch (err) {
    return res.status(400).json({ error: String(err.message ?? err) });
  }
  res.json({ ok: true, restartRequired });
});

const PROMPT_FILE = path.join(ROOT, 'server', 'prompts', 'system-prompt.md');

app.get('/api/system-prompt', (req, res) => {
  res.type('text/plain').send(fs.readFileSync(PROMPT_FILE, 'utf8'));
});

// Read fresh on every generation, so edits apply to the next song.
app.put('/api/system-prompt', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    return res.status(400).json({ error: 'System prompt cannot be empty.' });
  }
  fs.writeFileSync(PROMPT_FILE, req.body);
  res.json({ ok: true });
});

// ---- generation loop & settings ----

// Body: { songwriter?: bool, composer?: bool } — either or both.
app.post('/api/engine', (req, res) => {
  engine.setFlags({ songwriter: req.body?.songwriter, composer: req.body?.composer });
  res.json({ songwriterOn: store.state.songwriterOn, composerOn: store.state.composerOn });
});

app.post('/api/generating/cancel', (req, res) => {
  try {
    engine.cancelRender();
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: String(err.message ?? err) });
  }
});

app.patch('/api/settings', (req, res) => {
  for (const key of ['autoplay', 'padFromBookmarks', 'semanticNoise', 'albumArt']) {
    if (key in (req.body ?? {})) store.state.settings[key] = Boolean(req.body[key]);
  }
  store.touch();
  res.json(store.state.settings);
});

app.patch('/api/guidance', (req, res) => {
  const allowed = ['genre', 'bpm', 'mood', 'instruments', 'vocals', 'language', 'extra', 'concepts'];
  for (const key of allowed) {
    if (key in (req.body ?? {})) store.state.guidance[key] = String(req.body[key] ?? '');
  }
  store.touch();
  res.json(store.state.guidance);
});

// ---- upcoming drafts ----

// Add a custom (user-written) song to the up-next queue. It won't be
// dispatched to ComfyUI until both caption and lyrics are filled in.
app.post('/api/drafts', (req, res) => {
  const draft = {
    id: crypto.randomUUID(),
    name: String(req.body?.name ?? '').trim() || 'Untitled',
    caption: String(req.body?.caption ?? ''),
    lyrics: String(req.body?.lyrics ?? ''),
    custom: true,
    concepts: null,
    injected: false,
    noise: null,
    createdAt: Date.now(),
  };
  store.state.drafts.push(draft);
  store.touch();
  res.json(draft);
});

// Reorder the up-next queue. Ids not listed (e.g. a draft written while the
// user was dragging) keep their place at the end.
app.post('/api/drafts/reorder', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids must be an array' });
  const byId = new Map(store.state.drafts.map((d) => [d.id, d]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const d of store.state.drafts) if (!next.includes(d)) next.push(d);
  store.state.drafts = next;
  store.touch();
  res.json({ ok: true });
});

app.patch('/api/drafts/:id', (req, res) => {
  const draft = store.draft(req.params.id);
  if (!draft) {
    return res.status(409).json({ error: 'That song was already sent to ComfyUI.' });
  }
  for (const key of ['name', 'caption', 'lyrics']) {
    if (typeof req.body?.[key] === 'string') draft[key] = req.body[key];
  }
  // Held drafts are skipped by the composer until released.
  if ('hold' in (req.body ?? {})) draft.hold = Boolean(req.body.hold);
  store.touch();
  res.json(draft);
});

app.post('/api/drafts/:id/regenerate', async (req, res) => {
  try {
    res.json(await engine.regenerateDraft(req.params.id));
  } catch (err) {
    res.status(503).json({ error: String(err.message ?? err) });
  }
});

app.delete('/api/drafts/:id', (req, res) => {
  const before = store.state.drafts.length;
  store.state.drafts = store.state.drafts.filter((d) => d.id !== req.params.id);
  if (store.state.drafts.length === before) {
    return res.status(404).json({ error: 'Unknown draft' });
  }
  store.touch();
  res.json({ ok: true });
});

// Re-render an existing song: copy its exact name/caption/lyrics to the front
// of Up next. With { hold: true } the draft waits for the user to edit and
// release it; otherwise the composer picks it up next.
app.post('/api/songs/:id/reroll', (req, res) => {
  const song = store.song(req.params.id);
  if (!song) return res.status(404).json({ error: 'Unknown song' });
  const draft = {
    id: crypto.randomUUID(),
    name: song.name,
    caption: song.caption,
    lyrics: song.lyrics,
    custom: true,
    hold: Boolean(req.body?.hold),
    concepts: null,
    injected: false,
    noise: null,
    createdAt: Date.now(),
  };
  store.state.drafts.unshift(draft);
  store.touch();
  res.json(draft);
});

// ---- playlists ----

app.post('/api/playlists/reorder', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids must be an array' });
  const byId = new Map(store.state.playlists.map((p) => [p.id, p]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const p of store.state.playlists) if (!next.includes(p)) next.push(p);
  store.state.playlists = next;
  store.touch();
  res.json({ ok: true });
});

app.post('/api/playlists', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Playlist name is required.' });
  const playlist = { id: crypto.randomUUID(), name, songIds: [], createdAt: Date.now() };
  store.state.playlists.push(playlist);
  store.touch();
  res.json(playlist);
});

app.patch('/api/playlists/:id', (req, res) => {
  const playlist = store.playlist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Unknown playlist' });
  const name = String(req.body?.name ?? '').trim();
  if (name) playlist.name = name;
  store.touch();
  res.json(playlist);
});

app.delete('/api/playlists/:id', (req, res) => {
  const before = store.state.playlists.length;
  store.state.playlists = store.state.playlists.filter((p) => p.id !== req.params.id);
  if (store.state.playlists.length === before) {
    return res.status(404).json({ error: 'Unknown playlist' });
  }
  store.touch();
  res.json({ ok: true });
});

// Body: { add: [songIds], remove: [songIds] } — either or both.
app.post('/api/playlists/:id/songs', (req, res) => {
  const playlist = store.playlist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Unknown playlist' });
  const add = Array.isArray(req.body?.add) ? req.body.add : [];
  const remove = new Set(Array.isArray(req.body?.remove) ? req.body.remove : []);
  playlist.songIds = playlist.songIds.filter((id) => !remove.has(id));
  for (const id of add) {
    if (store.song(id) && !playlist.songIds.includes(id)) playlist.songIds.push(id);
  }
  store.touch();
  res.json(playlist);
});

// ---- songs / queue / history / bookmarks ----

app.post('/api/queue/clear', (req, res) => {
  store.state.queue = [];
  store.touch();
  res.json({ ok: true });
});

// Bulk bookmark toggle: { ids: [songIds], bookmarked: boolean }.
app.post('/api/songs/bulk-bookmark', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const bookmarked = Boolean(req.body?.bookmarked);
  for (const id of ids) {
    const song = store.song(id);
    if (song) song.bookmarked = bookmarked;
  }
  store.touch();
  res.json({ ok: true });
});

app.post('/api/songs/:id/played', (req, res) => {
  const song = store.song(req.params.id);
  if (!song) return res.status(404).json({ error: 'Unknown song' });
  store.state.queue = store.state.queue.filter((id) => id !== song.id);
  store.state.history.push({ songId: song.id, playedAt: Date.now() });
  song.playCount = (song.playCount ?? 0) + 1;
  store.touch();
  res.json({ ok: true });
});

app.post('/api/songs/:id/bookmark', (req, res) => {
  const song = store.song(req.params.id);
  if (!song) return res.status(404).json({ error: 'Unknown song' });
  song.bookmarked = 'bookmarked' in (req.body ?? {}) ? Boolean(req.body.bookmarked) : !song.bookmarked;
  store.touch();
  res.json({ bookmarked: song.bookmarked });
});

// Reroll a bookmarked song's album cover: drop the art AND the cached image
// prompt so both get regenerated fresh on the next idle window.
app.post('/api/songs/:id/cover/regenerate', (req, res) => {
  const song = store.song(req.params.id);
  if (!song) return res.status(404).json({ error: 'Unknown song' });
  if (!song.bookmarked) {
    return res.status(400).json({ error: 'Only bookmarked songs get album covers.' });
  }
  if (song.cover) fs.rm(path.join(COVERS_DIR, song.cover), { force: true }, () => {});
  song.cover = null;
  song.coverPrompt = null;
  store.touch();
  covers.reset(song.id);
  covers.tick().catch(() => {}); // start right away if the pipeline is idle
  res.json({ ok: true });
});

app.post('/api/queue/:id/remove', (req, res) => {
  store.state.queue = store.state.queue.filter((id) => id !== req.params.id);
  store.touch();
  res.json({ ok: true });
});

app.delete('/api/songs/:id', (req, res) => {
  const song = store.song(req.params.id);
  if (!song) return res.status(404).json({ error: 'Unknown song' });
  store.state.songs = store.state.songs.filter((s) => s.id !== song.id);
  store.state.queue = store.state.queue.filter((id) => id !== song.id);
  store.state.history = store.state.history.filter((h) => h.songId !== song.id);
  fs.rm(path.join(SONGS_DIR, song.file), { force: true }, () => {});
  if (song.cover) fs.rm(path.join(COVERS_DIR, song.cover), { force: true }, () => {});
  store.touch();
  res.json({ ok: true });
});

// ---- static ----

app.use('/audio', express.static(SONGS_DIR));
app.use('/covers', express.static(COVERS_DIR));

const webDist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|audio).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .status(200)
      .send('Bragi server is running, but the web UI is not built yet. Run: npm run build'),
  );
}

const port = Number(process.env.PORT ?? config.server?.port ?? 7700);
app.listen(port, () => {
  console.log(`[bragi] server on http://localhost:${port}`);
  console.log(`[bragi] LM Studio: ${config.lmstudio.baseUrl} (${config.lmstudio.model})`);
  console.log(`[bragi] ComfyUI:   ${config.comfyui.baseUrl}`);
  console.log(`[bragi] songs dir: ${SONGS_DIR}`);
});
