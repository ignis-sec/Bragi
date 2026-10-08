import { generateSongMeta, unloadModel } from './lmstudio.js';
import { LlamaCppBackend } from './llamacpp.js';
import { ControlVectorBuilder, retainVector, releaseVector } from './jlens.js';
import { acquire, preemptedError } from './gpu.js';
import { requestSong, parseConceptSpec } from './songwriter.js';

// A "session" spans one batch of songwriting between ComfyUI renders:
//   begin(guidance) -> writeSong() xN -> end()
// lmstudio: begin is a no-op, end unloads via `lms unload`. Pinned concept
//   seeds (guidance.concepts) are prompt-only.
// llamacpp: begin builds j-lens control vectors and spawns llama-server with
//   them; end kills the process (freeing VRAM). Concepts are injected into the
//   residual stream AND (optionally) mentioned in the prompt.
// broker: same injection, but an external GPU broker runs llama-server —
//   begin acquires a GPU lease for Bragi's model with the vectors, end
//   releases it (see gpu.js).
//
// The engine may set these hooks on a session before begin():
//   onConcepts(concepts, injected), onNoise(noise) — live status updates
//   onQueued(holder) — waiting for the GPU behind another workload
//   waitSignal() — an AbortSignal that cancels waiting for the GPU
//   urgent — the songs are user requests (broker backend: urgent leases)

export function llamaSampling(config) {
  const cfg = config.llamacpp ?? {};
  return {
    temperature: cfg.temperature,
    topP: cfg.topP,
    topK: cfg.topK,
    minP: cfg.minP,
    repeatPenalty: cfg.repeatPenalty,
    maxTokens: cfg.maxTokens,
  };
}

export function llmBackend(config) {
  return config.llm?.backend ?? 'llamacpp';
}

class LmStudioSession {
  constructor(config) {
    this.config = config;
    this.name = 'lmstudio';
    this.concepts = null;
    this.noise = null;
    this.onNoise = null;
    this.onConcepts = null;
  }

  async begin(guidance, _settings) {
    const pinned = parseConceptSpec(guidance?.concepts);
    this.concepts = pinned.length ? pinned.map((c) => ({ word: c.word, strength: null })) : null;
    return { concepts: this.concepts, injected: false, noise: null };
  }

  async writeSong(guidance, recentSongs, { prompt } = {}) {
    // Prompt-only seeds are cheap — always use the currently entered ones.
    const pinned = parseConceptSpec(guidance?.concepts);
    const next = pinned.length ? pinned.map((c) => ({ word: c.word, strength: null })) : null;
    if (JSON.stringify(next) !== JSON.stringify(this.concepts)) {
      this.concepts = next;
      this.onConcepts?.(next, false);
    }
    return generateSongMeta(this.config, guidance, recentSongs, this.concepts, prompt);
  }

  async end() {
    this.concepts = null;
    await unloadModel(this.config);
  }
}

// Concept injection + per-song semantic noise, shared by both llama-server
// backends. Subclasses decide how the vectors reach llama-server
// (applyVectors) and where requests go (request).
class InjectingSession {
  constructor(config) {
    this.config = config;
    this.vectors = new ControlVectorBuilder(config);
    this.concepts = null;
    this.conceptSpec = null; // the raw Concept seeds string the vector was built from
    this.conceptsVector = null;
    this.noise = null; // current song's roll: {words, weights, strength} | null
    this.noiseVector = null;
    this.noiseEnabled = false;
    this.songsWritten = 0;
    this.onNoise = null;
    this.onConcepts = null;
    this.onQueued = null;
    this.waitSignal = null;
  }

  get controlVectors() {
    return [this.conceptsVector, this.noiseVector].filter(Boolean);
  }

  // Hold a built vector file so concurrent builds don't prune it.
  _setVector(key, file) {
    releaseVector(this[key]);
    retainVector(file);
    this[key] = file;
  }

  async begin(guidance, settings = {}) {
    const j = this.config.llamacpp?.jlens ?? {};
    this.conceptSpec = String(guidance?.concepts ?? '').trim();
    const concepts = this.vectors.pickConcepts(guidance, parseConceptSpec);
    this._setVector(
      'conceptsVector',
      concepts?.length ? await this.vectors.makeControlVector(concepts) : null,
    );
    this.noiseEnabled = Boolean(j.enabled && settings.semanticNoise);
    if (this.noiseEnabled) {
      const built = await this.vectors.makeNoiseVector();
      this._setVector('noiseVector', built.path);
      this.noise = built.info;
    }
    await this.applyVectors();
    this.concepts = concepts;
    return { concepts, injected: Boolean(concepts?.length), noise: this.noise };
  }

  async writeSong(guidance, recentSongs, { prompt } = {}) {
    const j = this.config.llamacpp?.jlens ?? {};
    let changed = false;

    // The Concept seeds field may have been edited mid-session (or a
    // commission brings its own guidance) — re-pick and rebuild whenever the
    // entered spec differs from what's injected now.
    const spec = String(guidance?.concepts ?? '').trim();
    if (spec !== this.conceptSpec) {
      this.conceptSpec = spec;
      this.concepts = this.vectors.pickConcepts(guidance, parseConceptSpec);
      this._setVector(
        'conceptsVector',
        this.concepts?.length ? await this.vectors.makeControlVector(this.concepts) : null,
      );
      this.onConcepts?.(this.concepts, Boolean(this.concepts?.length));
      changed = true;
    }

    // Fresh noise roll for every song.
    if (this.noiseEnabled && this.songsWritten > 0) {
      const built = await this.vectors.makeNoiseVector();
      this.noise = built.info;
      this._setVector('noiseVector', built.path);
      this.onNoise?.(this.noise);
      changed = true;
    }

    // Control vectors are fixed when llama-server starts, so any change means
    // a new process — shared between concept and noise updates.
    if (changed) await this.applyVectors();
    this.songsWritten++;
    const mention = (j.mentionInPrompt ?? true) ? this.concepts : null;
    return this.request({
      model: 'bragi', // llama-server serves a single model; the name is ignored
      sampling: llamaSampling(this.config),
      guidance,
      recentSongs,
      concepts: mention,
      prompt,
    });
  }

  async end() {
    this.concepts = null;
    this._setVector('conceptsVector', null);
    this._setVector('noiseVector', null);
  }
}

class LlamaCppSession extends InjectingSession {
  constructor(config) {
    super(config);
    this.name = 'llamacpp';
    this.backend = new LlamaCppBackend(config);
  }

  async applyVectors() {
    await this.backend.start(this.controlVectors);
  }

  request(opts) {
    return requestSong({ ...opts, baseUrl: this.backend.baseUrl });
  }

  async end() {
    await super.end();
    await this.backend.stop();
  }
}

// Bragi's model, served by an external GPU broker under a lease. A
// revoked lease aborts the request in flight (err.preempted) so the engine
// can keep what it has and wait for the GPU again.
class BrokerSession extends InjectingSession {
  constructor(config) {
    super(config);
    this.name = 'broker';
    this.lease = null;
    this.urgent = false;
  }

  // New vectors = a new lease; the broker restarts llama-server with them.
  async applyVectors() {
    this.lease?.release();
    this.lease = null;
    this.lease = await acquire(this.config, {
      workload: 'llm',
      profile: 'bragi',
      controlVectors: this.controlVectors,
      purpose: this.urgent ? 'Writing a requested song' : 'Writing songs',
      urgent: this.urgent,
      signal: this.waitSignal?.(),
      onQueued: this.onQueued,
    });
  }

  async request(opts) {
    if (!this.lease || this.lease.isRevoked) await this.applyVectors();
    const lease = this.lease;
    try {
      return await requestSong({ ...opts, baseUrl: lease.baseUrl, signal: lease.signal });
    } catch (err) {
      if (lease.isRevoked) throw preemptedError(lease.revokeReason);
      throw err;
    }
  }

  async end() {
    this.lease?.release();
    this.lease = null;
    await super.end();
  }
}

export function createLLM(config) {
  const backend = llmBackend(config);
  if (backend === 'broker') return new BrokerSession(config);
  if (backend === 'llamacpp') return new LlamaCppSession(config);
  if (backend !== 'lmstudio') {
    throw new Error(`Unknown llm.backend "${backend}" — use "llamacpp", "lmstudio" or "broker"`);
  }
  return new LmStudioSession(config);
}

// A plain (no control vectors) chat target for one-off jobs like album cover
// prompts. Returns { target, isRevoked(), close() }; `target` is spread into
// requestCoverPrompt.
export async function openPlainLLM(config, { purpose, signal, onQueued } = {}) {
  const backend = llmBackend(config);
  if (backend === 'broker') {
    const lease = await acquire(config, {
      workload: 'llm',
      profile: 'bragi',
      controlVectors: [],
      purpose,
      signal,
      onQueued,
    });
    return {
      target: {
        baseUrl: lease.baseUrl,
        model: 'bragi',
        sampling: llamaSampling(config),
        signal: lease.signal,
      },
      isRevoked: () => lease.isRevoked,
      close: async () => lease.release(),
    };
  }
  if (backend === 'llamacpp') {
    const llama = new LlamaCppBackend(config);
    await llama.start([]);
    return {
      target: { baseUrl: llama.baseUrl, model: 'bragi', sampling: llamaSampling(config) },
      isRevoked: () => false,
      close: () => llama.stop(),
    };
  }
  const lm = config.lmstudio;
  return {
    target: {
      baseUrl: lm.baseUrl,
      apiKey: process.env.LLM_API_KEY,
      model: lm.model,
      ttl: lm.ttlSeconds,
      sampling: {
        temperature: lm.temperature,
        topP: lm.topP,
        topK: lm.topK,
        minP: lm.minP,
        repeatPenalty: lm.repeatPenalty,
        maxTokens: lm.maxTokens,
      },
    },
    isRevoked: () => false,
    close: () => unloadModel(config),
  };
}
