import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { freeComfy, renderImage } from './comfyui.js';
import { requestCoverPrompt } from './songwriter.js';
import { openPlainLLM } from './llm.js';
import { acquire, comfyViaBroker } from './gpu.js';
import { logEvent } from './logger.js';
import { fileURLToPath } from 'node:url';

export const COVERS_DIR = path.join(DATA_DIR, 'covers');

const COVER_PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompts',
  'cover-prompt.md',
);

const RETRY_AFTER_MS = 10 * 60_000;

// Generates album covers for bookmarked songs while the main pipeline is
// idle. Two phases per batch, matching the app's VRAM choreography:
//   1. The LLM writes image prompts for all pending covers (one session),
//      each stored on the song so a later tick can resume without the LLM.
//   2. ComfyUI renders the covers one by one, yielding as soon as the main
//      loop has work to do (queue drained / loop re-enabled).
// Via a GPU broker, both phases run under GPU leases (the prompts on Bragi's
// model without control vectors); a revoked lease ends the batch quietly and
// a later tick resumes it.
export class CoverEngine {
  constructor(store, cfg, engine) {
    this.store = store;
    this.config = cfg;
    this.engine = engine;
    this.running = false;
    this.failedAt = new Map(); // songId -> last failure timestamp
  }

  start() {
    const interval = (this.config.covers?.intervalSec ?? 15) * 1000;
    setInterval(() => {
      this.tick().catch((err) => console.warn('[covers]', err.message));
    }, interval);
  }

  // Forget a song's failure backoff (used when the user asks for a reroll).
  reset(songId) {
    this.failedAt.delete(songId);
  }

  candidates() {
    return this.store.state.songs.filter(
      (s) =>
        s.bookmarked &&
        !s.cover &&
        Date.now() - (this.failedAt.get(s.id) ?? 0) > RETRY_AFTER_MS,
    );
  }

  // Safe to grab the GPU: nothing rendering, no songwriter session, and the
  // main loop is parked in a waiting phase (or off entirely).
  engineIdle() {
    const { state } = this.store;
    const phase = state.engine?.phase;
    return (
      !state.generating &&
      !this.engine.inSession &&
      !this.engine.writing &&
      ['idle', 'queue-full', 'waiting-drafts', 'lookahead-full', 'error'].includes(phase)
    );
  }

  // The main loop has (or is about to have) real work — get out of the way.
  shouldYield() {
    const { state } = this.store;
    const readyDraft = state.drafts.some(
      (d) => d.caption?.trim() && d.lyrics?.trim() && !d.hold,
    );
    return (
      this.engine.hasPriorityWork() ||
      (state.songwriterOn && state.drafts.length < this.engine.draftTarget) ||
      (state.composerOn &&
        readyDraft &&
        state.queue.length < (this.config.generation.maxQueuedSongs ?? 3))
    );
  }

  async tick() {
    if (this.running) return;
    if (!this.store.state.settings.albumArt) return;
    const todo = this.candidates();
    if (!todo.length || !this.engineIdle() || this.shouldYield()) return;

    this.running = true;
    this.engine.coverBusy = true; // main loop waits while we hold the GPU
    try {
      const needPrompts = todo.filter((s) => !s.coverPrompt);
      if (needPrompts.length) await this.writePrompts(needPrompts);

      for (const song of todo) {
        if (this.shouldYield()) {
          logEvent('covers', 'yielding to the song pipeline');
          break;
        }
        if (!song.coverPrompt || !song.bookmarked || song.cover) continue;
        try {
          await this.renderCover(song);
        } catch (err) {
          if (err.preempted || err.aborted) {
            logEvent('covers', `cover batch interrupted: ${err.message}`);
            break;
          }
          logEvent('covers', `cover FAILED for "${song.name}": ${err.message}`);
          this.failedAt.set(song.id, Date.now());
        }
      }
    } catch (err) {
      if (!err.preempted && !err.aborted) throw err;
      logEvent('covers', `cover batch interrupted: ${err.message}`);
    } finally {
      this.engine.coverBusy = false;
      this.running = false;
    }
  }

  // Waiting for a GPU lease is called off once the song pipeline needs it.
  yieldSignal() {
    const ctl = new AbortController();
    const timer = setInterval(() => {
      if (this.shouldYield()) ctl.abort();
    }, 1000);
    return { signal: ctl.signal, done: () => clearInterval(timer) };
  }

  // One LLM session writes image prompts for every pending cover.
  async writePrompts(songs) {
    logEvent('covers', `writing cover prompts for ${songs.length} song(s)`);
    if (!comfyViaBroker(this.config)) await freeComfy(this.config);
    const system = fs.readFileSync(COVER_PROMPT_PATH, 'utf8');
    const wait = this.yieldSignal();
    let llm;
    try {
      llm = await openPlainLLM(this.config, {
        purpose: 'Writing album cover prompts',
        signal: wait.signal,
      });
    } finally {
      wait.done();
    }
    try {
      for (const song of songs) {
        if (this.shouldYield()) break;
        try {
          const prompt = await requestCoverPrompt({
            ...llm.target,
            system,
            user: `Title: ${song.name}\n\nCaption:\n${song.caption}\n\nLyrics:\n${song.lyrics}`,
          });
          song.coverPrompt = prompt.replace(/\s+/g, ' ').trim();
          logEvent('covers', `cover prompt for "${song.name}"`, { prompt: song.coverPrompt });
          this.store.touch();
        } catch (err) {
          if (llm.isRevoked()) {
            logEvent('covers', 'GPU lease revoked — cover prompts paused');
            break;
          }
          logEvent('covers', `prompt FAILED for "${song.name}": ${err.message}`);
          this.failedAt.set(song.id, Date.now());
        }
      }
    } finally {
      await llm.close();
    }
  }

  async renderCover(song) {
    let lease = null;
    if (comfyViaBroker(this.config)) {
      const wait = this.yieldSignal();
      try {
        lease = await acquire(this.config, {
          workload: 'comfyui',
          purpose: `Album cover for "${song.name}"`,
          signal: wait.signal,
        });
      } finally {
        wait.done();
      }
    }
    logEvent('covers', `rendering cover for "${song.name}"`);
    let rendered;
    try {
      rendered = await renderImage(this.config, {
        workflow: this.config.covers?.workflow ?? './album_cover.json',
        vars: { prompt: song.coverPrompt },
        label: `cover "${song.name}"`,
        overrides: this.config.covers?.workflowOverrides,
        baseUrl: lease?.baseUrl,
        signal: lease?.signal,
      });
    } catch (err) {
      if (lease?.isRevoked) err.preempted = true;
      throw err;
    } finally {
      lease?.release();
    }
    const { buffer, ext } = rendered;
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    const file = `${song.id}${ext}`;
    fs.writeFileSync(path.join(COVERS_DIR, file), buffer);
    song.cover = file;
    this.store.touch();
    logEvent('covers', `cover ready: ${file}`);
  }
}
