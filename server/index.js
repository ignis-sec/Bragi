import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, ROOT, SONGS_DIR } from './config.js';
import { Store } from './store.js';
import { Engine } from './loop.js';
import { createLLM } from './llm.js';

const store = new Store();
const engine = new Engine(store, config, createLLM(config));

const app = express();
app.use(express.json({ limit: '1mb' }));

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
