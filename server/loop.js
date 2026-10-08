import crypto from 'node:crypto';
import { renderSong, freeComfy } from './comfyui.js';
import { createLLM } from './llm.js';
import { acquire, comfyViaBroker } from './gpu.js';
import { stripParentheses } from './songwriter.js';
import { logEvent } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isRenderable = (d) => Boolean(d.caption?.trim() && d.lyrics?.trim() && !d.hold);

// The lease ended or the wait was called off — not an error to report.
export const isYield = (err) => Boolean(err?.preempted || err?.aborted);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The pipeline keeps a queue of editable drafts ahead of ComfyUI:
//
//   [songwriter session: top drafts up to lookahead + 1]
//        -> [stop/unload songwriter] -> [ComfyUI renders the oldest draft]
//
// The pool is refilled every time a render finishes (before the next one
// starts), writing however many drafts are missing — so even after deletes or
// rewrites, `draftLookahead` drafts stay editable during the whole render. All
// writing happens between renders, so the GPU never holds both models.
//
// A "songwriter session" is Bragi's own llama-server (default), LM Studio, or
// a GPU lease on an external broker's llama-server — see llm.js. With
// comfyui.via "broker" each render also runs under a GPU lease and the broker
// evicts whatever held the GPU before; with "direct" Bragi frees ComfyUI's
// VRAM itself before writing.
//
// Songs requested over the API jump the line: commissions (POST /api/write)
// are written first, and priority drafts (commissions, POST /api/compose)
// render before anything else — even with both toggles off.
export class Engine {
  constructor(store, config, { player } = {}) {
    this.store = store;
    this.config = config;
    this.player = player ?? null;
    this.llm = null; // created fresh at each session, so config edits hot-apply
    this.running = false;
    this.writing = false; // a songwriter call is in flight
    this.inSession = false; // a songwriter session (begin..end) is active
    this.coverBusy = false; // the cover engine holds the GPU
    this.renderAbort = null; // AbortController while ComfyUI is rendering
    this.waitAbort = new AbortController(); // cancels waiting for a GPU lease
  }

  get draftTarget() {
    return this.config.generation.draftLookahead ?? 3;
  }

  // Commissions to write or priority drafts to render.
  hasPriorityWork() {
    const { state } = this.store;
    return (
      state.commissions.some((c) => c.status === 'waiting') ||
      state.drafts.some((d) => d.priority && isRenderable(d))
    );
  }

  // Cancel the render in progress; the half-made song is discarded.
  cancelRender() {
    if (!this.store.state.generating || !this.renderAbort) {
      throw new Error('Nothing is rendering right now.');
    }
    this.renderAbort.abort();
  }

  setFlags({ songwriter, composer }) {
    const { state } = this.store;
    const turnedOff =
      (songwriter !== undefined && !songwriter && state.songwriterOn) ||
      (composer !== undefined && !composer && state.composerOn);
    if (songwriter !== undefined) state.songwriterOn = Boolean(songwriter);
    if (composer !== undefined) state.composerOn = Boolean(composer);
    // Don't hold a place in the broker's GPU queue for work that's off now.
    if (turnedOff) this.stopWaiting();
    if (state.songwriterOn || state.composerOn) {
      state.lastError = null;
      this.kick();
    }
    this.store.touch();
  }

  stopWaiting() {
    this.waitAbort.abort();
    this.waitAbort = new AbortController();
  }

  setPhase(phase, detail = null) {
    const cur = this.store.state.engine;
    if (cur?.phase === phase && cur?.detail === detail) return; // keep `since`
    logEvent('engine', `phase: ${phase}${detail ? ` — ${detail}` : ''}`);
    this.store.state.engine = { phase, detail, since: Date.now() };
    this.store.touch();
  }

  kick() {
    if (!this.running) {
      this.run().catch((err) => console.error('[engine] fatal:', err));
    }
  }

  onQueued(holder) {
    this.setPhase('waiting-gpu', holder ? `GPU busy (${holder})` : 'Waiting for the GPU');
  }

  async makeDraft(guidance = this.store.state.guidance, { prompt } = {}) {
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
      const meta = await this.llm.writeSong(guidance, recent, { prompt });
      // Optional hard guarantee — the prompt forbids parentheses, but the
      // model ignores it now and then.
      if (this.config.generation.stripParentheses) {
        meta.lyrics = stripParentheses(meta.lyrics);
      }
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

  async beginSession(guidance = this.store.state.guidance, { urgent = false } = {}) {
    const { state } = this.store;
    this.llm = createLLM(this.config);
    this.llm.urgent = urgent;
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
    this.llm.onQueued = (holder) => this.onQueued(holder);
    this.llm.waitSignal = () => this.waitAbort.signal;
    this.inSession = true;
    let info;
    try {
      info = await this.llm.begin(guidance, state.settings);
    } catch (err) {
      this.inSession = false;
      await this.llm.end().catch(() => {});
      throw err;
    }
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

  // Free ComfyUI's VRAM before loading an LLM — only when Bragi talks to
  // ComfyUI directly; a GPU broker evicts by itself.
  async freeComfyIfDirect() {
    if (comfyViaBroker(this.config)) return;
    this.setPhase('unloading-comfy', 'Freeing VRAM for the songwriter');
    await freeComfy(this.config);
  }

  // Fill the draft queue up to `total`, one songwriter call at a time.
  // Stops early when requested songs show up.
  async topUpDrafts(total) {
    const { state } = this.store;
    while (state.songwriterOn && state.drafts.length < total && !this.hasPriorityWork()) {
      this.setPhase('writing-draft', `Writing drafts (${state.drafts.length + 1}/${total})`);
      try {
        const draft = await this.makeDraft();
        logEvent('engine', `draft written: "${draft.name}"`, { caption: draft.caption });
        state.drafts.push(draft);
      } catch (err) {
        // Preempted: keep what's written and wait for the GPU again.
        if (isYield(err)) throw err;
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

  // Priority drafts go to the front of Up next, after earlier priority ones.
  insertPriorityDraft(draft) {
    const { drafts } = this.store.state;
    const at = drafts.findIndex((d) => !d.priority);
    const entry = { ...draft, priority: true };
    drafts.splice(at === -1 ? drafts.length : at, 0, entry);
    this.store.touch();
    this.kick();
    return entry;
  }

  // Write every waiting commission in one session; each becomes a priority
  // draft. A commission's guidance replaces the global guidance for its song.
  async writeCommissions() {
    const { state } = this.store;
    const nextWaiting = () => state.commissions.find((c) => c.status === 'waiting');
    const guidanceOf = (c) => c?.guidance ?? state.guidance;
    await this.freeComfyIfDirect();
    this.setPhase('starting-llm', 'Starting the songwriter for a requested song');
    await this.beginSession(guidanceOf(nextWaiting()), { urgent: true });
    try {
      let c;
      while ((c = nextWaiting())) {
        c.status = 'writing';
        c.error = null;
        this.setPhase(
          'writing-draft',
          clip(`Writing a requested song${c.prompt ? `: ${c.prompt}` : ''}`, 120),
        );
        try {
          const draft = await this.makeDraft(guidanceOf(c), { prompt: c.prompt });
          logEvent('engine', `commission written: "${draft.name}"`, { commission: c.id });
          if (!state.commissions.includes(c)) continue; // dropped meanwhile
          state.commissions = state.commissions.filter((x) => x !== c);
          this.insertPriorityDraft({ ...draft, play: Boolean(c.play), commissionId: c.id });
        } catch (err) {
          if (isYield(err)) {
            c.status = 'waiting';
            throw err;
          }
          c.status = 'failed';
          c.error = String(err.message ?? err);
          logEvent('engine', `commission FAILED: ${c.error}`, { commission: c.id });
        }
        this.store.touch();
      }
    } finally {
      this.setPhase('unloading-llm', 'Stopping the songwriter');
      await this.endSession();
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
    if (!state.generating && !comfyViaBroker(this.config)) await freeComfy(this.config);
    await this.beginSession();
    try {
      const draft = await this.makeDraft();
      // The draft may have moved (or been dispatched) while the LLM wrote.
      const nowIndex = state.drafts.findIndex((d) => d.id === id);
      if (nowIndex === -1) throw new Error('That draft was already sent to ComfyUI.');
      const old = state.drafts[nowIndex];
      state.drafts[nowIndex] = old.priority
        ? { ...draft, priority: true, play: old.play, commissionId: old.commissionId }
        : draft;
      this.store.touch();
      return state.drafts[nowIndex];
    } finally {
      await this.endSession();
    }
  }

  // Index of the next draft to render: priority drafts first, others only
  // when `priorityOnly` is off.
  nextRenderIndex(priorityOnly) {
    const { drafts } = this.store.state;
    const p = drafts.findIndex((d) => d.priority && isRenderable(d));
    if (p !== -1 || priorityOnly) return p;
    return drafts.findIndex(isRenderable);
  }

  // Render one draft. Via a GPU broker it runs under a ComfyUI lease: a
  // revoked lease interrupts the prompt and puts the draft back in front
  // (err.preempted, no lastError); the next round waits for the GPU again.
  async renderNext(priorityOnly) {
    const { state } = this.store;
    let lease = null;
    if (comfyViaBroker(this.config)) {
      const next = state.drafts[this.nextRenderIndex(priorityOnly)];
      const name = next?.name ?? 'a song';
      this.setPhase('waiting-gpu', `Waiting for the GPU to render “${name}”`);
      lease = await acquire(this.config, {
        workload: 'comfyui',
        purpose: `Rendering "${name}"`,
        urgent: Boolean(next?.priority), // someone asked for this song
        signal: this.waitAbort.signal,
        onQueued: (holder) => this.onQueued(holder),
      });
    }
    let dispatching = null;
    let preempted = false;
    try {
      // Up next may have changed while we waited for the GPU.
      const idx = this.nextRenderIndex(priorityOnly);
      if (idx === -1) return;
      dispatching = state.drafts.splice(idx, 1)[0];
      // Second pass at dispatch catches manual edits and custom drafts.
      if (this.config.generation.stripParentheses) {
        dispatching.lyrics = stripParentheses(dispatching.lyrics);
      }
      state.generating = { ...dispatching, startedAt: Date.now() };
      this.store.touch();

      this.setPhase('rendering-audio', dispatching.name);
      const abort = new AbortController();
      this.renderAbort = abort;
      lease?.onRevoke(() => {
        preempted = true;
        abort.abort();
      });
      const { file } = await renderSong(this.config, dispatching, {
        signal: abort.signal,
        baseUrl: lease?.baseUrl,
      });

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
      // A requested song with play: true jumps the queue and starts if the
      // speakers are silent.
      const playNow = Boolean(dispatching.priority && dispatching.play);
      if (playNow) state.queue.unshift(dispatching.id);
      else state.queue.push(dispatching.id);
      state.generating = null;
      state.lastError = null;
      this.store.touch();
      if (playNow) this.player?.songReady(dispatching.id).catch(() => {});
    } catch (err) {
      state.generating = null;
      if (err.cancelled && preempted) {
        console.log('[engine] render preempted:', dispatching?.name);
        state.drafts.unshift(dispatching);
        this.store.touch();
        err.preempted = true;
        throw err;
      }
      if (err.cancelled) {
        // User hit cancel: discard the song, keep the loop moving.
        console.log('[engine] render cancelled:', dispatching?.name);
        this.store.touch();
        return;
      }
      // Don't lose a song that failed to render — put it back in front.
      if (dispatching) state.drafts.unshift(dispatching);
      throw err;
    } finally {
      this.renderAbort = null;
      lease?.release();
    }
  }

  async run() {
    this.running = true;
    const { state } = this.store;
    try {
      while (state.songwriterOn || state.composerOn || this.hasPriorityWork()) {
        try {
          // The cover engine yields as soon as we have work — wait it out.
          if (this.coverBusy) {
            this.setPhase('covers', 'Album covers in the studio');
            await sleep(2000);
            continue;
          }

          // Requested songs are written before anything else...
          if (state.commissions.some((c) => c.status === 'waiting')) {
            await this.writeCommissions();
            continue;
          }

          // ...and rendered first — composer or not, full queue or not.
          if (this.nextRenderIndex(true) !== -1) {
            await this.renderNext(true);
            continue;
          }

          // Songwriter: keep the up-next pool filled to the lookahead.
          if (state.songwriterOn && state.drafts.length < this.draftTarget) {
            await this.freeComfyIfDirect();
            this.setPhase('starting-llm');
            await this.beginSession();
            try {
              await this.topUpDrafts(this.draftTarget);
            } finally {
              this.setPhase('unloading-llm', 'Stopping the songwriter');
              await this.endSession();
            }
            continue; // re-evaluate flags with a full pool
          }

          if (!state.composerOn) {
            if (state.songwriterOn) {
              this.setPhase('lookahead-full', `${state.drafts.length} drafts ready`);
            }
            await sleep(2000);
            continue;
          }

          // Composer: render from the pool. While the songwriter is on it
          // waits for the lookahead to fill (handled above); with the
          // songwriter off it drains whatever is there.
          if (state.queue.length >= (this.config.generation.maxQueuedSongs ?? 3)) {
            this.setPhase('queue-full', `${state.queue.length} songs waiting`);
            await sleep(3000);
            continue;
          }
          // Blank custom drafts and drafts held for editing are skipped.
          if (this.nextRenderIndex(false) === -1) {
            this.setPhase(
              'waiting-drafts',
              state.drafts.length ? 'Drafts are held or incomplete' : 'Up next is empty',
            );
            await sleep(3000);
            continue;
          }
          await this.renderNext(false);
        } catch (err) {
          this.renderAbort = null;
          if (isYield(err)) {
            // The broker took the GPU back (or we stopped waiting): not an
            // error — the next round queues for the GPU again.
            if (err.preempted) this.setPhase('preempted', 'Another workload needed the GPU');
            await sleep(1000);
            continue;
          }
          console.error('[engine]', err.message);
          logEvent('engine', `ERROR: ${err.message}`);
          state.lastError = String(err.message ?? err);
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
