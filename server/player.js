import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA_DIR, SONGS_DIR } from './config.js';
import { logEvent } from './logger.js';

const SOCKET = path.join(DATA_DIR, 'mpv.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function connect(file) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(file);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// One mpv process driven over its JSON IPC socket. Spawned on first use and
// again after it dies; emits 'ready' (fresh process), 'event' and 'exit'.
class Mpv extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.starting = null;
  }

  get running() {
    return Boolean(this.sock && !this.sock.destroyed);
  }

  async ensure() {
    if (this.running) return;
    if (!this.starting) this.starting = this._start().finally(() => (this.starting = null));
    await this.starting;
  }

  async _start() {
    fs.rmSync(SOCKET, { force: true });
    // BRAGI_MPV_ARGS lets tests run silently (e.g. "--ao=null").
    const extra = (process.env.BRAGI_MPV_ARGS ?? '').split(' ').filter(Boolean);
    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      `--input-ipc-server=${SOCKET}`,
      ...extra,
    ];
    logEvent('player', `spawning mpv ${args.join(' ')}`);
    const proc = spawn('mpv', args, { stdio: 'ignore' });
    let spawnError = null;
    proc.on('error', (err) => (spawnError = err));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      logEvent('player', `mpv exited (${signal ?? code})`);
      this.proc = null;
      this.sock?.destroy();
      this.emit('exit');
    });
    this.proc = proc;

    const deadline = Date.now() + 5000;
    let sock = null;
    while (!sock) {
      if (spawnError) {
        throw new Error(
          spawnError.code === 'ENOENT'
            ? 'mpv is not installed — it is needed for playback on the speakers'
            : `Could not start mpv: ${spawnError.message}`,
        );
      }
      if (proc.exitCode !== null || proc.signalCode) throw new Error('mpv exited during startup');
      try {
        sock = await connect(SOCKET);
      } catch {
        if (Date.now() > deadline) {
          proc.kill('SIGKILL');
          throw new Error('mpv did not open its IPC socket');
        }
        await sleep(50);
      }
    }

    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this._onMessage(JSON.parse(line));
        } catch {
          /* not JSON — ignore */
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
      for (const { reject } of this.pending.values()) reject(new Error('mpv went away'));
      this.pending.clear();
    });
    this.sock = sock;
    this.emit('ready');
  }

  _onMessage(msg) {
    if (msg.event) {
      this.emit('event', msg);
      return;
    }
    const waiter = this.pending.get(msg.request_id);
    if (!waiter) return;
    this.pending.delete(msg.request_id);
    if (msg.error === 'success') waiter.resolve(msg.data);
    else waiter.reject(new Error(`mpv: ${msg.error}`));
  }

  async command(...args) {
    await this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(`${JSON.stringify({ command: args, request_id: id })}\n`);
    });
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    this.sock?.destroy();
    if (proc && proc.exitCode === null) proc.kill('SIGTERM');
  }
}

// Server-side playback for output "speakers": owns store.state.player and
// the queue logic the dashboard used to run in the browser (auto-advance,
// autoplay, pad-from-bookmarks, previous). With output "browser" the
// dashboard plays locally and this stays idle.
//
// The position is published as an anchor ({positionS, timestampMs, speed});
// clients extrapolate, so time-pos ticks only reach the store on drift.
export class Player {
  constructor(store) {
    this.store = store;
    this.mpv = new Mpv();
    this.armed = false; // someone started playback since boot
    this.lastEnded = null;
    this.timePos = null;
    this.lastAnchorAt = 0;
    this.entryId = null; // mpv playlist entry of the current song (null while loading)
    this.loaded = false; // mpv finished opening the current file
    this.pendingSeek = null; // a seek asked for while the file was still loading
    this.errors = 0; // consecutive files mpv failed to play
    this.failedAt = 0;
    this.seenQueue = new Set(store.state.queue);
    this.chain = Promise.resolve();
    this.autoPending = false;

    this.mpv.on('ready', () => this._setup());
    this.mpv.on('event', (e) => this._onEvent(e));
    this.mpv.on('exit', () => {
      if (this.p.status !== 'idle') this._setIdle();
    });
    store.on('change', () => this._scheduleAutoStart());
  }

  get p() {
    return this.store.state.player;
  }

  get state() {
    return this.store.state.player;
  }

  // ---- public API (serialized so overlapping requests can't interleave) ----

  play(songId) {
    return this._serial(async () => {
      this.armed = true;
      if (this.p.output !== 'speakers') this._setOutput('speakers');
      if (songId) {
        const song = this.store.song(songId);
        if (!song) throw httpError(404, 'Unknown song');
        await this._load(song);
      } else if (this.p.status === 'paused') {
        await this.mpv.command('set_property', 'pause', false);
      } else if (this.p.status === 'idle' && !(await this._advance())) {
        throw httpError(409, 'Nothing to play — the queue is empty.');
      }
      return this.p;
    });
  }

  pause() {
    return this._serial(async () => {
      if (this.p.status === 'playing') await this.mpv.command('set_property', 'pause', true);
      return this.p;
    });
  }

  toggle() {
    if (this.p.status === 'idle') return this.play();
    return this._serial(async () => {
      this.armed = true;
      await this.mpv.command('set_property', 'pause', this.p.status === 'playing');
      return this.p;
    });
  }

  next() {
    return this._serial(async () => {
      this.armed = true;
      this._requireSpeakers();
      const id = this.p.songId;
      if (id) {
        this.lastEnded = id;
        this.store.markPlayed(id);
      }
      if (!(await this._advance())) await this._stop();
      return this.p;
    });
  }

  // Spotify behaviour: restart if more than 3 s in, else the previous song.
  previous() {
    return this._serial(async () => {
      this.armed = true;
      this._requireSpeakers();
      const { history } = this.store.state;
      if (this.p.songId && (this.position() > 3 || !history.length)) {
        await this._seek(0);
      } else if (history.length) {
        const song = this.store.song(history[history.length - 1].songId);
        if (song) await this._load(song);
      }
      return this.p;
    });
  }

  seek(positionS) {
    return this._serial(async () => {
      const t = Number(positionS);
      if (!Number.isFinite(t) || t < 0) throw httpError(400, 'positionS must be a number ≥ 0');
      if (!this.p.songId) throw httpError(409, 'Nothing is playing.');
      await this._seek(t);
      return this.p;
    });
  }

  setVolume(volume) {
    return this._serial(async () => {
      const v = Number(volume);
      if (!Number.isFinite(v)) throw httpError(400, 'volume must be a number between 0 and 1');
      this.p.volume = Math.min(1, Math.max(0, v));
      this.store.touch(); // persisted
      if (this.mpv.running) await this.mpv.command('set_property', 'volume', this.p.volume * 100);
      return this.p;
    });
  }

  setOutput(output) {
    return this._serial(async () => {
      if (output !== 'speakers' && output !== 'browser') {
        throw httpError(400, 'output must be "speakers" or "browser"');
      }
      if (output === 'browser' && this.p.songId) await this._stop();
      this._setOutput(output);
      return this.p;
    });
  }

  // A priority song with play: true just rendered (already at the queue front).
  songReady(songId) {
    return this._serial(async () => {
      if (this.p.output !== 'speakers' || this.p.status !== 'idle') return;
      const song = this.store.song(songId);
      if (!song) return;
      this.armed = true;
      await this._load(song).catch((err) => this._failed(err));
    });
  }

  // The song is being deleted — don't keep playing a file that's going away.
  forget(songId) {
    if (this.p.songId !== songId) return Promise.resolve();
    return this._serial(() => this._stop());
  }

  // Current position, extrapolated from the anchor.
  position() {
    const { positionS, timestampMs, speed } = this.p.position;
    return positionS + (speed * (Date.now() - timestampMs)) / 1000;
  }

  shutdown() {
    this.mpv.kill();
  }

  // ---- internals ----

  _serial(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  _requireSpeakers() {
    if (this.p.output !== 'speakers') {
      throw httpError(409, 'Playback is in the browser — switch the output to speakers first.');
    }
  }

  async _setup() {
    try {
      await this.mpv.command('observe_property', 1, 'time-pos');
      await this.mpv.command('observe_property', 2, 'pause');
      await this.mpv.command('observe_property', 3, 'duration');
      await this.mpv.command('set_property', 'volume', this.p.volume * 100);
    } catch (err) {
      console.warn('[player] mpv setup failed:', err.message);
    }
  }

  _setOutput(output) {
    if (this.p.output === output) return;
    this.p.output = output;
    logEvent('player', `output -> ${output}`);
    this.store.touch(); // persisted
  }

  _anchor(positionS) {
    this.p.position = {
      positionS: Math.round(Math.max(0, positionS) * 1000) / 1000,
      timestampMs: Date.now(),
      speed: this.p.status === 'playing' ? 1 : 0,
    };
    this.lastAnchorAt = Date.now();
  }

  _setIdle() {
    this.entryId = null;
    this.loaded = false;
    this.pendingSeek = null;
    this.timePos = null;
    Object.assign(this.p, { status: 'idle', songId: null, durationS: null });
    this._anchor(0);
    this.store.notify();
  }

  async _load(song) {
    const file = path.join(SONGS_DIR, song.file);
    this.entryId = null; // ignore end-file events of whatever played before
    this.loaded = false;
    this.pendingSeek = null;
    Object.assign(this.p, { status: 'playing', songId: song.id, durationS: null });
    this.timePos = 0;
    this._anchor(0);
    this.store.notify();
    logEvent('player', `playing "${song.name}"`);
    try {
      await this.mpv.command('set_property', 'pause', false);
      const res = await this.mpv.command('loadfile', file, 'replace');
      this.entryId = res?.playlist_entry_id ?? '*'; // '*': mpv too old to tell entries apart
    } catch (err) {
      this._setIdle();
      throw err;
    }
  }

  async _stop() {
    if (this.mpv.running) await this.mpv.command('stop').catch(() => {});
    this._setIdle();
  }

  // mpv refuses seeks while a file is still opening; those wait for
  // file-loaded (e.g. play + seek when the dashboard hands a song over).
  async _seek(t) {
    if (this.loaded) await this.mpv.command('seek', t, 'absolute');
    else this.pendingSeek = t;
    this.timePos = t;
    this._anchor(t);
    this.store.notify();
  }

  // Next from the queue, else a random bookmark when padding is on.
  async _advance() {
    if (this.p.output !== 'speakers') return false;
    const { queue, settings } = this.store.state;
    const next = queue.map((id) => this.store.song(id)).find(Boolean);
    if (next) {
      await this._load(next);
      return true;
    }
    if (settings.padFromBookmarks && this.armed) return this._pad();
    return false;
  }

  async _pad() {
    let pool = this.store.state.songs.filter((s) => s.bookmarked);
    if (pool.length > 1) pool = pool.filter((s) => s.id !== this.lastEnded);
    if (!pool.length) return false;
    await this._load(pool[Math.floor(Math.random() * pool.length)]);
    return true;
  }

  _onEvent(e) {
    if (e.event === 'property-change') {
      if (e.name === 'time-pos') this._onTimePos(e.data);
      else if (e.name === 'pause') this._onPause(Boolean(e.data));
      else if (e.name === 'duration' && typeof e.data === 'number' && this.p.songId) {
        if (this.p.durationS !== e.data) {
          this.p.durationS = Math.round(e.data * 1000) / 1000;
          this.store.notify();
        }
      }
    } else if (e.event === 'file-loaded') {
      this.loaded = true;
      if (this.pendingSeek != null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.mpv.command('seek', t, 'absolute').catch(() => {});
      }
    } else if (e.event === 'playback-restart') {
      this.errors = 0;
    } else if (e.event === 'end-file') {
      // end-file "stop" = we replaced/stopped the file ourselves; events
      // while a new file is loading belong to the previous one.
      const ours = this.entryId === '*' || (this.entryId != null && e.playlist_entry_id === this.entryId);
      if (!ours || !this.p.songId) return;
      if (e.reason === 'eof') this._serial(() => this._finished());
      else if (e.reason === 'error') {
        this._serial(() => this._failed(new Error(e.file_error ?? 'could not play the file')));
      }
    }
  }

  _onTimePos(t) {
    if (typeof t !== 'number') return;
    this.timePos = t;
    if (this.p.status !== 'playing') return;
    // Only re-anchor when the extrapolation is off (seeks, stalls), and not
    // more than every couple of seconds.
    if (Math.abs(t - this.position()) > 1 && Date.now() - this.lastAnchorAt > 2000) {
      this._anchor(t);
      this.store.notify();
    }
  }

  _onPause(paused) {
    if (!this.p.songId) return;
    const status = paused ? 'paused' : 'playing';
    if (this.p.status === status) return;
    this.p.status = status;
    this._anchor(this.timePos ?? this.position());
    this.store.notify();
  }

  async _finished() {
    const id = this.p.songId;
    if (!id) return;
    this.lastEnded = id;
    this.store.markPlayed(id);
    this._setIdle();
    await this._advance().catch((err) => this._failed(err));
  }

  // mpv couldn't play a file. Skip it (it stays in the library); after a
  // few failures in a row stop auto-advancing until someone presses play.
  async _failed(err) {
    console.warn('[player]', err.message);
    logEvent('player', `playback failed: ${err.message}`);
    const id = this.p.songId;
    this.failedAt = Date.now();
    this._setIdle();
    if (++this.errors >= 3) {
      this.armed = false;
      this.errors = 0;
      return;
    }
    if (id) {
      this.store.state.queue = this.store.state.queue.filter((q) => q !== id);
      this.store.touch();
    }
    setTimeout(() => this._scheduleAutoStart(), 5000).unref();
  }

  // Mirrors the old browser effect: whenever nothing plays, start the queue
  // (after a first play, or — with autoplay — when a new song lands in it),
  // or pad from bookmarks.
  _scheduleAutoStart() {
    if (this.autoPending) return;
    this.autoPending = true;
    setImmediate(() => {
      this.autoPending = false;
      this._serial(() => this._autoStart()).catch(() => {});
    });
  }

  async _autoStart() {
    const { queue, settings } = this.store.state;
    const fresh = queue.some((id) => !this.seenQueue.has(id));
    this.seenQueue = new Set(queue);
    if (this.p.output !== 'speakers' || this.p.status !== 'idle') return;
    if (Date.now() - this.failedAt < 5000) return;
    try {
      if (queue.length) {
        if (this.armed || (settings.autoplay && fresh)) await this._advance();
      } else if (settings.padFromBookmarks && this.armed) {
        await this._pad();
      }
    } catch (err) {
      await this._failed(err);
    }
  }
}
