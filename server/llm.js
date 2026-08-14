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
  }

  async begin(guidance, _settings) {
    const pinned = parseConceptSpec(guidance?.concepts);
    this.concepts = pinned.length ? pinned.map((c) => ({ word: c.word, strength: null })) : null;
    return { concepts: this.concepts, injected: false, noise: null };
  }

  async writeSong(guidance, recentSongs) {
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
  }

  async begin(guidance, settings = {}) {
    const j = this.config.llamacpp?.jlens ?? {};
    const concepts = this.backend.pickConcepts(guidance, parseConceptSpec);
    const vectors = [];
    if (concepts?.length) vectors.push(await this.backend.makeControlVector(concepts));
    let noise = null;
    if (j.enabled && settings.semanticNoise) {
      const built = await this.backend.makeNoiseVector();
      vectors.push(built.path);
      noise = built.info;
    }
    await this.backend.start(vectors);
    this.concepts = concepts;
    return { concepts, injected: Boolean(concepts?.length), noise };
  }

  async writeSong(guidance, recentSongs) {
    const cfg = this.config.llamacpp ?? {};
    const j = cfg.jlens ?? {};
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
