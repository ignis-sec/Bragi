import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT, SONGS_DIR } from './config.js';

export { ROOT, SONGS_DIR };
export const DATA_DIR = path.join(ROOT, 'data');
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
      // data/audio/<uuid>.mp3 layout into the songs folder.
      this.state.songs = this.state.songs.filter((s) => {
        if (!s?.file) return false;
        if (fs.existsSync(path.join(SONGS_DIR, s.file))) return true;
        const legacy = path.join(LEGACY_AUDIO_DIR, s.file);
        if (fs.existsSync(legacy)) {
          try {
            fs.renameSync(legacy, path.join(SONGS_DIR, s.file));
            return true;
          } catch (err) {
            console.warn(`[store] could not migrate ${s.file}:`, err.message);
          }
        }
        return false;
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
