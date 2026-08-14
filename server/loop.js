import crypto from 'node:crypto';
import { generateSongMeta, unloadModel } from './lmstudio.js';
import { renderSong, freeComfy } from './comfyui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pipeline keeps a queue of editable drafts ahead of ComfyUI:
//
//   [free ComfyUI VRAM] -> [Qwen tops drafts up to lookahead + 1] -> [unload Qwen]
//        -> [ComfyUI renders the oldest draft]
//
// The pool is refilled every time a render finishes (before the next one
// starts), writing however many drafts are missing — so even after deletes or
// rewrites, `draftLookahead` drafts stay editable during the whole render. All
// writing happens between renders, so the GPU never holds both models.
export class Engine {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.running = false;
    this.writing = false; // a Qwen call is in flight
    this.renderAbort = null; // AbortController while ComfyUI is rendering
  }

  // Cancel the render in progress; the half-made song is discarded.
  cancelRender() {
    if (!this.store.state.generating || !this.renderAbort) {
      throw new Error('Nothing is rendering right now.');
    }
    this.renderAbort.abort();
  }

  get draftTarget() {
    return this.config.generation.draftLookahead ?? 3;
  }

  setLoop(enabled) {
    this.store.state.loopEnabled = enabled;
    if (enabled) {
      this.store.state.lastError = null;
      this.kick();
    }
    this.store.touch();
  }

  setPhase(phase, detail = null) {
    this.store.state.engine = { phase, detail, since: Date.now() };
    this.store.touch();
  }

  kick() {
    if (!this.running) {
      this.run().catch((err) => console.error('[engine] fatal:', err));
    }
  }

  async makeDraft() {
    this.writing = true;
    try {
      const { state } = this.store;
      const recent = [
        ...state.songs.slice(-8).map((s) => ({ name: s.name, caption: s.caption })),
        ...state.drafts.map((d) => ({ name: d.name, caption: d.caption })),
      ];
      const meta = await generateSongMeta(this.config, state.guidance, recent);
      return { id: crypto.randomUUID(), ...meta, createdAt: Date.now() };
    } finally {
      this.writing = false;
    }
  }

  // Fill the draft queue up to `total`, one Qwen call at a time.
  async topUpDrafts(total) {
    const { state } = this.store;
    while (state.loopEnabled && state.drafts.length < total) {
      this.setPhase('writing-draft', `Writing drafts (${state.drafts.length + 1}/${total})`);
      try {
        state.drafts.push(await this.makeDraft());
      } catch (err) {
        // With at least one draft in hand, render it rather than stalling.
        if (state.drafts.length) {
          console.warn('[engine] draft top-up incomplete:', err.message);
          break;
        }
        throw err;
      }
      this.store.touch();
    }
  }

  // Manual "reroll" of one draft from the dashboard.
  async regenerateDraft(id) {
    if (this.writing) {
      throw new Error('The songwriter is already working — try again in a moment.');
    }
    const { state } = this.store;
    const index = state.drafts.findIndex((d) => d.id === id);
    if (index === -1) throw new Error('That draft no longer exists.');
    // Free ComfyUI's VRAM first — unless it's mid-render and actually using it.
    if (!state.generating) await freeComfy(this.config);
    const draft = await this.makeDraft();
    // The draft may have moved (or been dispatched) while Qwen was writing.
    const nowIndex = state.drafts.findIndex((d) => d.id === id);
    if (nowIndex === -1) throw new Error('That draft was already sent to ComfyUI.');
    state.drafts[nowIndex] = draft;
    this.store.touch();
    await unloadModel(this.config);
    return draft;
  }

  async run() {
    this.running = true;
    const { state } = this.store;
    try {
      while (state.loopEnabled) {
        let dispatching = null;
        try {
          if (state.queue.length >= (this.config.generation.maxQueuedSongs ?? 3)) {
            this.setPhase('queue-full', `${state.queue.length} songs waiting`);
            await sleep(3000);
            continue;
          }

          // Refill the pool to lookahead + 1: the extra one is dispatched to
          // ComfyUI right below, leaving `draftTarget` drafts waiting and
          // editable for the whole render. (Free ComfyUI's VRAM first —
          // mirror of the Qwen unload.)
          if (state.drafts.length < this.draftTarget + 1) {
            this.setPhase('unloading-comfy', 'Freeing VRAM for Qwen');
            await freeComfy(this.config);
            await this.topUpDrafts(this.draftTarget + 1);
            this.setPhase('unloading-llm', 'Freeing VRAM for ComfyUI');
            await unloadModel(this.config);
          }
          if (!state.loopEnabled) break;
          if (!state.drafts.length) continue; // top-up interrupted

          // Oldest draft goes to the studio; the rest stay editable.
          dispatching = state.drafts.shift();
          state.generating = { ...dispatching, startedAt: Date.now() };
          this.store.touch();

          this.setPhase('rendering-audio', dispatching.name);
          this.renderAbort = new AbortController();
          const { file } = await renderSong(this.config, dispatching, {
            signal: this.renderAbort.signal,
          });
          this.renderAbort = null;

          state.songs.push({
            id: dispatching.id,
            name: dispatching.name,
            caption: dispatching.caption,
            lyrics: dispatching.lyrics,
            file,
            createdAt: dispatching.createdAt,
            readyAt: Date.now(),
            bookmarked: false,
            playCount: 0,
          });
          state.queue.push(dispatching.id);
          state.generating = null;
          state.lastError = null;
          this.store.touch();
        } catch (err) {
          this.renderAbort = null;
          if (err.cancelled) {
            // User hit cancel: discard the song, keep the loop moving.
            console.log('[engine] render cancelled:', dispatching?.name);
            state.generating = null;
            this.store.touch();
            continue;
          }
          console.error('[engine]', err.message);
          state.lastError = String(err.message ?? err);
          state.generating = null;
          // Don't lose a song that failed to render — put it back in front.
          if (dispatching) state.drafts.unshift(dispatching);
          this.setPhase('error', state.lastError);
          this.store.touch();
          await sleep(10_000);
        }
      }
    } finally {
      this.running = false;
      this.setPhase('idle');
    }
  }
}
