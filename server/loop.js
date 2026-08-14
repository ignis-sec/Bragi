import crypto from 'node:crypto';
import { renderSong, freeComfy } from './comfyui.js';
import { createLLM } from './llm.js';
import { logEvent } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pipeline keeps a queue of editable drafts ahead of ComfyUI:
//
//   [free ComfyUI VRAM] -> [songwriter session: top drafts up to lookahead + 1]
//        -> [stop/unload songwriter] -> [ComfyUI renders the oldest draft]
//
// The pool is refilled every time a render finishes (before the next one
// starts), writing however many drafts are missing — so even after deletes or
// rewrites, `draftLookahead` drafts stay editable during the whole render. All
// writing happens between renders, so the GPU never holds both models.
//
// A "songwriter session" is LM Studio (loaded/unloaded around the batch) or a
// llama-server process (spawned/killed around it), optionally with a j-lens
// control vector injecting this session's concepts into the residual stream.
export class Engine {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.llm = null; // created fresh at each session, so config edits hot-apply
    this.running = false;
    this.writing = false; // a songwriter call is in flight
    this.inSession = false; // a songwriter session (begin..end) is active
    this.renderAbort = null; // AbortController while ComfyUI is rendering
  }

  get draftTarget() {
    return this.config.generation.draftLookahead ?? 3;
  }

  // Cancel the render in progress; the half-made song is discarded.
  cancelRender() {
    if (!this.store.state.generating || !this.renderAbort) {
      throw new Error('Nothing is rendering right now.');
    }
    this.renderAbort.abort();
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
    logEvent('engine', `phase: ${phase}${detail ? ` — ${detail}` : ''}`);
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
      // Optionally list recent songs in the prompt with a "write something
      // clearly different" instruction (Settings > Songwriter).
      const recent = (this.config.generation.recentSongsInPrompt ?? true)
        ? [
            ...state.songs.slice(-8).map((s) => ({ name: s.name, caption: s.caption })),
            ...state.drafts.map((d) => ({ name: d.name, caption: d.caption })),
          ]
        : [];
      const meta = await this.llm.writeSong(state.guidance, recent);
      return {
        id: crypto.randomUUID(),
        ...meta,
        concepts: state.session?.concepts ?? null,
        injected: state.session?.injected ?? false,
        noise: state.session?.noise ?? null,
        createdAt: Date.now(),
      };
    } finally {
      this.writing = false;
    }
  }

  async beginSession() {
    const { state } = this.store;
    this.llm = createLLM(this.config);
    // Per-song noise rotation: keep the sidebar's session status showing the
    // roll that's actually being injected right now.
    this.llm.onNoise = (noise) => {
      if (this.store.state.session) {
        this.store.state.session.noise = noise;
        this.store.touch();
      }
    };
    this.llm.onConcepts = (concepts, injected) => {
      if (this.store.state.session) {
        this.store.state.session.concepts = concepts;
        this.store.state.session.injected = injected;
        this.store.touch();
      }
    };
    const info = await this.llm.begin(state.guidance, state.settings);
    this.inSession = true;
    state.session = {
      backend: this.llm.name,
      concepts: info.concepts ?? null,
      injected: info.injected ?? false,
      noise: info.noise ?? null,
    };
    logEvent('engine', `songwriter session begin (${this.llm.name})`, state.session);
    this.store.touch();
  }

  async endSession() {
    this.inSession = false;
    this.store.state.session = null;
    logEvent('engine', 'songwriter session end');
    await this.llm.end().catch((err) => console.warn('[engine] session end:', err.message));
    this.store.touch();
  }

  // Fill the draft queue up to `total`, one songwriter call at a time.
  async topUpDrafts(total) {
    const { state } = this.store;
    while (state.loopEnabled && state.drafts.length < total) {
      this.setPhase('writing-draft', `Writing drafts (${state.drafts.length + 1}/${total})`);
      try {
        const draft = await this.makeDraft();
        logEvent('engine', `draft written: "${draft.name}"`, { caption: draft.caption });
        state.drafts.push(draft);
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
    if (this.writing || this.inSession) {
      throw new Error('The songwriter is already working — try again in a moment.');
    }
    const { state } = this.store;
    if (!state.drafts.some((d) => d.id === id)) throw new Error('That draft no longer exists.');
    // Free ComfyUI's VRAM first — unless it's mid-render and actually using it.
    if (!state.generating) await freeComfy(this.config);
    await this.beginSession();
    try {
      const draft = await this.makeDraft();
      // The draft may have moved (or been dispatched) while the LLM wrote.
      const nowIndex = state.drafts.findIndex((d) => d.id === id);
      if (nowIndex === -1) throw new Error('That draft was already sent to ComfyUI.');
      state.drafts[nowIndex] = draft;
      this.store.touch();
      return draft;
    } finally {
      await this.endSession();
    }
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
          // mirror of the songwriter unload.)
          if (state.drafts.length < this.draftTarget + 1) {
            this.setPhase('unloading-comfy', 'Freeing VRAM for the songwriter');
            await freeComfy(this.config);
            this.setPhase('starting-llm');
            await this.beginSession();
            try {
              await this.topUpDrafts(this.draftTarget + 1);
            } finally {
              this.setPhase('unloading-llm', 'Freeing VRAM for ComfyUI');
              await this.endSession();
            }
          }
          if (!state.loopEnabled) break;
          if (!state.drafts.length) continue; // top-up interrupted

          // First render-ready draft goes to the studio; blank custom drafts
          // are skipped until the user fills them in.
          const readyIdx = state.drafts.findIndex(
            (d) => d.caption?.trim() && d.lyrics?.trim(),
          );
          if (readyIdx === -1) {
            this.setPhase('waiting-drafts', 'All drafts are incomplete');
            await sleep(3000);
            continue;
          }
          dispatching = state.drafts.splice(readyIdx, 1)[0];
          state.generating = { ...dispatching, startedAt: Date.now() };
          this.store.touch();

          this.setPhase('rendering-audio', dispatching.name);
          this.renderAbort = new AbortController();
          const { file } = await renderSong(this.config, dispatching, {
            signal: this.renderAbort.signal,
          });
          this.renderAbort = null;

          logEvent('engine', `song ready: "${dispatching.name}" -> ${file}`);
          state.songs.push({
            id: dispatching.id,
            name: dispatching.name,
            caption: dispatching.caption,
            lyrics: dispatching.lyrics,
            concepts: dispatching.concepts ?? null,
            injected: dispatching.injected ?? false,
            noise: dispatching.noise ?? null,
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
          logEvent('engine', `ERROR: ${err.message}`);
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
