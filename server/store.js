import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT, SONGS_DIR, DATA_DIR } from './config.js';
import { songFilename } from './comfyui.js';

const UUID_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i;

export { ROOT, SONGS_DIR, DATA_DIR };
const LEGACY_AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY_GUIDANCE = {
  genre: '',
  bpm: '',
  mood: '',
  instruments: '',
  vocals: '',
  language: '',
  extra: '',
  concepts: '',
};

const DEFAULT_SETTINGS = {
  autoplay: false,
  padFromBookmarks: false,
};

export class Store extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    fs.mkdirSync(SONGS_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.state = {
      loopEnabled: false,
      engine: { phase: 'idle', detail: null, since: Date.now() },
      lastError: null,
      guidance: { ...EMPTY_GUIDANCE },
      settings: { ...DEFAULT_SETTINGS },
      // Upcoming songs Qwen already wrote, oldest first — all editable until
      // the moment one is handed to ComfyUI.
      drafts: [],
      // The song currently rendering in ComfyUI.
      generating: null,
      // Active songwriter session: { backend, concepts, injected } | null.
      session: null,
      // Library of finished songs, oldest first.
      songs: [],
      // Ordered ids of finished songs waiting to be played.
      queue: [],
      // Listen history entries: { songId, playedAt }, oldest first.
      history: [],
    };
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(DB_FILE)) return;
      const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      this.state.guidance = { ...EMPTY_GUIDANCE, ...(saved.guidance ?? {}) };
      this.state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) };
      this.state.drafts = saved.drafts ?? (saved.draft ? [saved.draft] : []);
      this.state.songs = saved.songs ?? [];
      this.state.queue = saved.queue ?? [];
      this.state.history = saved.history ?? [];
      // Keep songs whose audio exists; migrate files from the legacy
      // data/audio/<uuid>.mp3 layout into the songs folder, and give
      // uuid-named files their proper song name.
      this.state.songs = this.state.songs.filter((s) => {
        if (!s?.file) return false;
        let ok = fs.existsSync(path.join(SONGS_DIR, s.file));
        if (!ok) {
          const legacy = path.join(LEGACY_AUDIO_DIR, s.file);
          if (fs.existsSync(legacy)) {
            try {
              fs.renameSync(legacy, path.join(SONGS_DIR, s.file));
              ok = true;
            } catch (err) {
              console.warn(`[store] could not migrate ${s.file}:`, err.message);
            }
          }
        }
        if (ok && UUID_FILE_RE.test(s.file)) {
          const nice = songFilename(s.name, path.extname(s.file));
          try {
            fs.renameSync(path.join(SONGS_DIR, s.file), path.join(SONGS_DIR, nice));
            s.file = nice;
          } catch (err) {
            console.warn(`[store] could not rename ${s.file}:`, err.message);
          }
        }
        return ok;
      });
      const ids = new Set(this.state.songs.map((s) => s.id));
      this.state.queue = this.state.queue.filter((id) => ids.has(id));
      this.state.history = this.state.history.filter((h) => ids.has(h.songId));
    } catch (err) {
      console.warn('[store] could not load db.json:', err.message);
    }
  }

  // Mark the state changed: notify SSE listeners and schedule a save.
  touch() {
    this.emit('change', this.state);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  _save() {
    const { guidance, settings, drafts, songs, queue, history } = this.state;
    try {
      fs.writeFileSync(
        DB_FILE,
        JSON.stringify({ guidance, settings, drafts, songs, queue, history }, null, 2),
      );
    } catch (err) {
      console.warn('[store] could not save db.json:', err.message);
    }
  }

  song(id) {
    return this.state.songs.find((s) => s.id === id) ?? null;
  }

  draft(id) {
    return this.state.drafts.find((d) => d.id === id) ?? null;
  }
}
