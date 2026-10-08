import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT, SONGS_DIR, DATA_DIR } from './config.js';
import { db, kvGet, kvSet } from './db.js';
import { songFilename } from './comfyui.js';

const UUID_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i;

export { ROOT, SONGS_DIR, DATA_DIR };
const LEGACY_DB_FILE = path.join(DATA_DIR, 'db.json');
const LEGACY_AUDIO_DIR = path.join(DATA_DIR, 'audio');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

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
  semanticNoise: false,
  albumArt: true,
};

// Only output and volume survive a restart; playback always starts idle.
const DEFAULT_PLAYER_PREFS = { output: 'speakers', volume: 0.9 };

function idlePlayer({ output, volume }) {
  return {
    output: output === 'browser' ? 'browser' : 'speakers',
    status: 'idle',
    songId: null,
    position: { positionS: 0, timestampMs: Date.now(), speed: 0 },
    durationS: null,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.9,
  };
}

export class Store extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    fs.mkdirSync(SONGS_DIR, { recursive: true });
    this.state = {
      // Songwriter fills the draft pool; composer renders it. Independent.
      songwriterOn: false,
      composerOn: false,
      engine: { phase: 'idle', detail: null, since: Date.now() },
      lastError: null,
      guidance: { ...EMPTY_GUIDANCE },
      settings: { ...DEFAULT_SETTINGS },
      // Upcoming songs the writer already produced, oldest first — editable
      // until the moment one is handed to ComfyUI.
      drafts: [],
      // The song currently rendering in ComfyUI.
      generating: null,
      // Active songwriter session: { backend, concepts, injected, noise } | null.
      session: null,
      // Library of finished songs, oldest first.
      songs: [],
      // Ordered ids of finished songs waiting to be played.
      queue: [],
      // Listen history entries: { songId, playedAt }, oldest first.
      history: [],
      // User playlists: { id, name, songIds: [], createdAt }.
      playlists: [],
      // Songs requested via POST /api/write, waiting to be written:
      // { id, prompt, guidance, play, status: waiting|writing|failed, error, createdAt }.
      commissions: [],
      // Server-side playback (mpv) — see player.js.
      player: idlePlayer(DEFAULT_PLAYER_PREFS),
    };
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!kvGet('stateInitialized')) {
        this._migrateLegacy();
        kvSet('stateInitialized', true);
      } else {
        this.state.guidance = { ...EMPTY_GUIDANCE, ...kvGet('guidance', {}) };
        this.state.settings = { ...DEFAULT_SETTINGS, ...kvGet('settings', {}) };
        const rows = (sql) => db.prepare(sql).all();
        this.state.songs = rows('SELECT data FROM songs ORDER BY position').map((r) =>
          JSON.parse(r.data),
        );
        this.state.drafts = rows('SELECT data FROM drafts ORDER BY position').map((r) =>
          JSON.parse(r.data),
        );
        this.state.queue = rows('SELECT song_id FROM queue ORDER BY position').map(
          (r) => r.song_id,
        );
        this.state.history = rows('SELECT song_id, played_at FROM history ORDER BY id').map(
          (r) => ({ songId: r.song_id, playedAt: r.played_at }),
        );
        this.state.playlists = rows('SELECT data FROM playlists ORDER BY position').map((r) =>
          JSON.parse(r.data),
        );
        // A commission interrupted mid-write by a restart is simply retried.
        this.state.commissions = rows('SELECT data FROM commissions ORDER BY position').map(
          (r) => {
            const c = JSON.parse(r.data);
            return c.status === 'writing' ? { ...c, status: 'waiting' } : c;
          },
        );
        this.state.player = idlePlayer({ ...DEFAULT_PLAYER_PREFS, ...kvGet('player', {}) });
      }
      this._reconcileFiles();
    } catch (err) {
      console.warn('[store] could not load state:', err.message);
    }
  }

  // One-time import of the old data/db.json. Album art is intentionally NOT
  // migrated (cover files are deleted, cover fields dropped) so the cover
  // engine regenerates everything with the current art-director pipeline.
  _migrateLegacy() {
    if (!fs.existsSync(LEGACY_DB_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(LEGACY_DB_FILE, 'utf8'));
    this.state.guidance = { ...EMPTY_GUIDANCE, ...(saved.guidance ?? {}) };
    this.state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) };
    this.state.drafts = saved.drafts ?? (saved.draft ? [saved.draft] : []);
    this.state.songs = (saved.songs ?? []).map((s) => {
      const { cover, coverPrompt, ...rest } = s;
      return rest;
    });
    this.state.queue = saved.queue ?? [];
    this.state.history = saved.history ?? [];
    fs.rmSync(COVERS_DIR, { recursive: true, force: true });
    this._save();
    fs.renameSync(LEGACY_DB_FILE, `${LEGACY_DB_FILE}.migrated`);
    console.log(
      `[store] migrated ${this.state.songs.length} songs from db.json into bragi.db (album art dropped for regeneration)`,
    );
  }

  // Keep songs whose audio exists; migrate files from the legacy
  // data/audio/<uuid>.mp3 layout and give uuid-named files their song name.
  _reconcileFiles() {
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
    for (const p of this.state.playlists) {
      p.songIds = (p.songIds ?? []).filter((id) => ids.has(id));
    }
  }

  // Mark the state changed: notify SSE listeners and schedule a save.
  touch() {
    this.emit('change', this.state);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  // Notify listeners of a transient change (playback position/status) that
  // isn't worth rewriting the database for.
  notify() {
    this.emit('change', this.state);
  }

  // A song finished or was skipped: off the queue, into the history.
  markPlayed(id) {
    const song = this.song(id);
    if (!song) return false;
    this.state.queue = this.state.queue.filter((q) => q !== song.id);
    this.state.history.push({ songId: song.id, playedAt: Date.now() });
    song.playCount = (song.playCount ?? 0) + 1;
    this.touch();
    return true;
  }

  _save() {
    const { guidance, settings, drafts, songs, queue, history, playlists, commissions, player } =
      this.state;
    try {
      db.exec('BEGIN');
      kvSet('guidance', guidance);
      kvSet('settings', settings);
      kvSet('player', { output: player.output, volume: player.volume });
      db.exec(
        'DELETE FROM songs; DELETE FROM drafts; DELETE FROM queue; DELETE FROM history; DELETE FROM playlists; DELETE FROM commissions;',
      );
      const insCommission = db.prepare('INSERT INTO commissions (position, data) VALUES (?, ?)');
      commissions.forEach((c, i) => insCommission.run(i, JSON.stringify(c)));
      const insPlaylist = db.prepare('INSERT INTO playlists (position, data) VALUES (?, ?)');
      playlists.forEach((p, i) => insPlaylist.run(i, JSON.stringify(p)));
      const insSong = db.prepare('INSERT INTO songs (position, data) VALUES (?, ?)');
      songs.forEach((s, i) => insSong.run(i, JSON.stringify(s)));
      const insDraft = db.prepare('INSERT INTO drafts (position, data) VALUES (?, ?)');
      drafts.forEach((d, i) => insDraft.run(i, JSON.stringify(d)));
      const insQueue = db.prepare('INSERT INTO queue (position, song_id) VALUES (?, ?)');
      queue.forEach((id, i) => insQueue.run(i, id));
      const insHist = db.prepare('INSERT INTO history (song_id, played_at) VALUES (?, ?)');
      history.forEach((h) => insHist.run(h.songId, h.playedAt));
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* not in a transaction */
      }
      console.warn('[store] could not save state:', err.message);
    }
  }

  song(id) {
    return this.state.songs.find((s) => s.id === id) ?? null;
  }

  draft(id) {
    return this.state.drafts.find((d) => d.id === id) ?? null;
  }

  playlist(id) {
    return this.state.playlists.find((p) => p.id === id) ?? null;
  }
}
