import { generateSongMeta, unloadModel } from './lmstudio.js';
import { LlamaCppBackend } from './llamacpp.js';
import { requestSong, parseConceptSpec } from './songwriter.js';

// A "session" spans one batch of Qwen songwriting between ComfyUI renders:
//   begin(guidance) -> writeSong() xN -> end()
// lmstudio: begin is a no-op, end unloads via `lms unload`. Pinned concept
//   seeds (guidance.concepts) are prompt-only.
// llamacpp: begin builds a j-lens control vector and spawns llama-server with
//   it; end kills the process (freeing VRAM). Concepts are injected into the
//   residual stream AND (optionally) mentioned in the prompt.

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

  async writeSong(guidance, recentSongs) {
    // Prompt-only seeds are cheap — always use the currently entered ones.
    const pinned = parseConceptSpec(guidance?.concepts);
    const next = pinned.length ? pinned.map((c) => ({ word: c.word, strength: null })) : null;
    if (JSON.stringify(next) !== JSON.stringify(this.concepts)) {
      this.concepts = next;
      this.onConcepts?.(next, false);
    }
    return generateSongMeta(this.config, guidance, recentSongs, this.concepts);
  }

  async end() {
    this.concepts = null;
    await unloadModel(this.config);
  }
}

class LlamaCppSession {
  constructor(config) {
    this.config = config;
    this.name = 'llamacpp';
    this.backend = new LlamaCppBackend(config);
    this.concepts = null;
    this.conceptSpec = null; // the raw Concept seeds string the vector was built from
    this.conceptsVector = null;
    this.noise = null; // current song's roll: {words, weights, strength} | null
    this.noiseVector = null;
    this.noiseEnabled = false;
    this.songsWritten = 0;
    this.onNoise = null; // optional callbacks, set by the engine for live UI
    this.onConcepts = null;
  }

  async begin(guidance, settings = {}) {
    const j = this.config.llamacpp?.jlens ?? {};
    this.conceptSpec = String(guidance?.concepts ?? '').trim();
    const concepts = this.backend.pickConcepts(guidance, parseConceptSpec);
    this.conceptsVector = concepts?.length ? await this.backend.makeControlVector(concepts) : null;
    this.noiseEnabled = Boolean(j.enabled && settings.semanticNoise);
    if (this.noiseEnabled) {
      const built = await this.backend.makeNoiseVector();
      this.noiseVector = built.path;
      this.noise = built.info;
    }
    await this.backend.start([this.conceptsVector, this.noiseVector]);
    this.concepts = concepts;
    return { concepts, injected: Boolean(concepts?.length), noise: this.noise };
  }

  async writeSong(guidance, recentSongs) {
    const cfg = this.config.llamacpp ?? {};
    const j = cfg.jlens ?? {};
    let needRestart = false;

    // The Concept seeds field may have been edited mid-session — re-pick and
    // rebuild whenever the entered spec differs from what's injected now.
    const spec = String(guidance?.concepts ?? '').trim();
    if (spec !== this.conceptSpec) {
      this.conceptSpec = spec;
      this.concepts = this.backend.pickConcepts(guidance, parseConceptSpec);
      this.conceptsVector = this.concepts?.length
        ? await this.backend.makeControlVector(this.concepts)
        : null;
      this.onConcepts?.(this.concepts, Boolean(this.concepts?.length));
      needRestart = true;
    }

    // Fresh noise roll for every song.
    if (this.noiseEnabled && this.songsWritten > 0) {
      const built = await this.backend.makeNoiseVector();
      this.noise = built.info;
      this.noiseVector = built.path;
      this.onNoise?.(this.noise);
      needRestart = true;
    }

    // Control vectors are fixed at process start, so any change means one
    // (warm) llama-server restart — shared between concept and noise updates.
    if (needRestart) await this.backend.start([this.conceptsVector, this.noiseVector]);
    this.songsWritten++;
    const mention = (j.mentionInPrompt ?? true) ? this.concepts : null;
    return requestSong({
      baseUrl: this.backend.baseUrl,
      model: 'muse', // llama-server serves a single model; the name is ignored
      sampling: {
        temperature: cfg.temperature,
        topP: cfg.topP,
        topK: cfg.topK,
        minP: cfg.minP,
        repeatPenalty: cfg.repeatPenalty,
        maxTokens: cfg.maxTokens,
      },
      guidance,
      recentSongs,
      concepts: mention,
    });
  }

  async end() {
    this.concepts = null;
    await this.backend.stop();
  }
}

export function createLLM(config) {
  const backend = config.llm?.backend ?? 'lmstudio';
  if (backend === 'llamacpp') return new LlamaCppSession(config);
  if (backend !== 'lmstudio') {
    throw new Error(`Unknown llm.backend "${backend}" — use "lmstudio" or "llamacpp"`);
  }
  return new LmStudioSession(config);
}
