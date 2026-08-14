import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, saveConfig, ROOT, SONGS_DIR } from './config.js';
import { Store } from './store.js';
import { Engine } from './loop.js';
import { logEvent, getLogs, clearLogs } from './logger.js';

const store = new Store();
const engine = new Engine(store, config);

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
const BAD_SEGMENT = /^(__proto__|constructor|prototype)$/;

function setConfigPath(target, dotted, value) {
  const parts = dotted.split('.');
  if (parts.some((p) => !p || BAD_SEGMENT.test(p))) {
    throw new Error(`invalid config path: ${dotted}`);
  }
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (node[key] == null || typeof node[key] !== 'object') {
      node[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    node = node[key];
  }
  const leaf = parts[parts.length - 1];
  node[/^\d+$/.test(leaf) ? Number(leaf) : leaf] = value;
}

app.get('/api/config', (req, res) => res.json(config));

// Body: { "lmstudio.temperature": 0.8, "llamacpp.jlens.layerRange.0": 10, ... }
// Leaf values are mutated on the live config object, so most changes apply to
// the next songwriter session / render without a restart.
app.patch('/api/config', (req, res) => {
  const changes = req.body ?? {};
  const restartRequired = [];
  try {
    for (const [dotted, value] of Object.entries(changes)) {
      setConfigPath(config, dotted, value);
      if (RESTART_PATHS.some((p) => dotted === p || dotted.startsWith(`${p}.`))) {
        restartRequired.push(dotted);
      }
    }
  } catch (err) {
    return res.status(400).json({ error: String(err.message ?? err) });
  }
  saveConfig();
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

app.post('/api/loop', (req, res) => {
  engine.setLoop(Boolean(req.body?.enabled));
  res.json({ loopEnabled: store.state.loopEnabled });
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
  for (const key of ['autoplay', 'padFromBookmarks']) {
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

app.patch('/api/drafts/:id', (req, res) => {
  const draft = store.draft(req.params.id);
  if (!draft) {
    return res.status(409).json({ error: 'That song was already sent to ComfyUI.' });
  }
  for (const key of ['name', 'caption', 'lyrics']) {
    if (typeof req.body?.[key] === 'string') draft[key] = req.body[key];
  }
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

// ---- songs / queue / history / bookmarks ----

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
  store.touch();
  res.json({ ok: true });
});

// ---- static ----

app.use('/audio', express.static(SONGS_DIR));

const webDist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|audio).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .status(200)
      .send('Muse server is running, but the web UI is not built yet. Run: npm run build'),
  );
}

const port = Number(process.env.PORT ?? config.server?.port ?? 7700);
app.listen(port, () => {
  console.log(`[muse] server on http://localhost:${port}`);
  console.log(`[muse] LM Studio: ${config.lmstudio.baseUrl} (${config.lmstudio.model})`);
  console.log(`[muse] ComfyUI:   ${config.comfyui.baseUrl}`);
  console.log(`[muse] songs dir: ${SONGS_DIR}`);
});
