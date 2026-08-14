import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, ROOT } from './config.js';
import { freeComfy, renderImage } from './comfyui.js';
import { requestCoverPrompt } from './songwriter.js';
import { LlamaCppBackend } from './llamacpp.js';
import { unloadModel } from './lmstudio.js';
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
//   1. Qwen writes image prompts for all pending covers (one LLM session),
//      each stored on the song so a later tick can resume without the LLM.
//   2. ComfyUI renders the covers one by one, yielding as soon as the main
//      loop has work to do (queue drained / loop re-enabled).
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
      ['idle', 'queue-full', 'waiting-drafts', 'error'].includes(phase)
    );
  }

  // The main loop has (or is about to have) real work — get out of the way.
  shouldYield() {
    const { state } = this.store;
    return (
      state.loopEnabled &&
      state.queue.length < (this.config.generation.maxQueuedSongs ?? 3)
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
          logEvent('covers', `cover FAILED for "${song.name}": ${err.message}`);
          this.failedAt.set(song.id, Date.now());
        }
      }
    } finally {
      this.engine.coverBusy = false;
      this.running = false;
    }
  }

  // One LLM session writes image prompts for every pending cover.
  async writePrompts(songs) {
    logEvent('covers', `writing cover prompts for ${songs.length} song(s)`);
    await freeComfy(this.config);
    const system = fs.readFileSync(COVER_PROMPT_PATH, 'utf8');
    const backend = this.config.llm?.backend ?? 'lmstudio';
    let llama = null;
    let target;
    try {
      if (backend === 'llamacpp') {
        llama = new LlamaCppBackend(this.config);
        await llama.start([]); // no control vectors for art direction
        const cfg = this.config.llamacpp ?? {};
        target = {
          baseUrl: llama.baseUrl,
          model: 'muse',
          sampling: { temperature: cfg.temperature, topP: cfg.topP, topK: cfg.topK, minP: cfg.minP, repeatPenalty: cfg.repeatPenalty },
        };
      } else {
        const lm = this.config.lmstudio;
        target = {
          baseUrl: lm.baseUrl,
          apiKey: process.env.LLM_API_KEY,
          model: lm.model,
          ttl: lm.ttlSeconds,
          sampling: { temperature: lm.temperature, topP: lm.topP, topK: lm.topK, minP: lm.minP, repeatPenalty: lm.repeatPenalty },
        };
      }
      for (const song of songs) {
        if (this.shouldYield()) break;
        try {
          const prompt = await requestCoverPrompt({
            ...target,
            system,
            user: `Title: ${song.name}\n\nCaption:\n${song.caption}\n\nLyrics:\n${song.lyrics}`,
          });
          song.coverPrompt = prompt.replace(/\s+/g, ' ').trim();
          logEvent('covers', `cover prompt for "${song.name}"`, { prompt: song.coverPrompt });
          this.store.touch();
        } catch (err) {
          logEvent('covers', `prompt FAILED for "${song.name}": ${err.message}`);
          this.failedAt.set(song.id, Date.now());
        }
      }
    } finally {
      if (llama) await llama.stop();
      else await unloadModel(this.config);
    }
  }

  async renderCover(song) {
    logEvent('covers', `rendering cover for "${song.name}"`);
    const { buffer, ext } = await renderImage(this.config, {
      workflow: this.config.covers?.workflow ?? './album_cover.json',
      vars: { prompt: song.coverPrompt },
      label: `cover "${song.name}"`,
    });
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    const file = `${song.id}${ext}`;
    fs.writeFileSync(path.join(COVERS_DIR, file), buffer);
    song.cover = file;
    this.store.touch();
    logEvent('covers', `cover ready: ${file}`);
  }
}
