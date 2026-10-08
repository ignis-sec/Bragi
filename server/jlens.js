import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT, DATA_DIR } from './config.js';
import { getConceptWords } from './wordlist.js';
import { logEvent } from './logger.js';

export const JLENS_DIR = path.join(DATA_DIR, 'jlens');

// Built vectors are named after their content: identical vectors get the same
// path (so a GPU broker can keep a warm llama-server across leases), changed
// ones a new path (so it never reuses a server started with stale vectors).
const BUILT_RE = /^(cv|noise)-[0-9a-f]{12}\.gguf$/;
const inUse = new Map(); // path -> refcount, held by live songwriter sessions

export function retainVector(file) {
  if (file) inUse.set(file, (inUse.get(file) ?? 0) + 1);
}

export function releaseVector(file) {
  if (!file || !inUse.has(file)) return;
  const n = inUse.get(file) - 1;
  if (n > 0) inUse.set(file, n);
  else inUse.delete(file);
}

function pruneVectors(keep) {
  let names = [];
  try {
    names = fs.readdirSync(JLENS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(JLENS_DIR, name);
    if (BUILT_RE.test(name) && file !== keep && !inUse.has(file)) {
      fs.rm(file, { force: true }, () => {});
    }
  }
}

// Move a freshly written vector to its content-addressed name.
function finalize(tmp, prefix) {
  const hash = crypto.createHash('sha1').update(fs.readFileSync(tmp)).digest('hex').slice(0, 12);
  const out = path.join(JLENS_DIR, `${prefix}-${hash}.gguf`);
  fs.renameSync(tmp, out);
  pruneVectors(out);
  return out;
}

function tmpPath(prefix) {
  fs.mkdirSync(JLENS_DIR, { recursive: true });
  return path.join(JLENS_DIR, `.${prefix}-${process.pid}-${crypto.randomUUID()}.gguf`);
}

function run(python, args, what) {
  return new Promise((resolve, reject) => {
    execFile(python, args, (err, stdout, stderr) => {
      if (err) {
        logEvent('jlens', `${what} FAILED`, { stderr: (stderr || err.message).trim() });
        reject(new Error(`${what} failed: ${(stderr || err.message).trim()}`));
      } else resolve(stdout);
    });
  });
}

// Builds j-lens control vectors (concept injection and sparse semantic noise)
// for whichever process serves the songwriter: Bragi's own llama-server or
// a GPU broker's. Building never touches the GPU.
export class ControlVectorBuilder {
  constructor(config) {
    this.cfg = config.llamacpp ?? {};
  }

  get enabled() {
    return Boolean(this.cfg.jlens?.enabled);
  }

  // Decide this session's concepts. Injection is opt-in: an empty Concept
  // seeds field means NO j-lens tampering. The literal word "random" draws
  // `conceptsPerSession` words from the wordlist instead.
  // Returns [{word, strength}] or null for a vanilla session.
  pickConcepts(guidance, parsePinned) {
    const j = this.cfg.jlens ?? {};
    if (!j.enabled) return null;
    const spec = String(guidance?.concepts ?? '').trim();
    if (!spec) return null;
    const [sMin, sMax] = j.strengthRange ?? [0.15, 0.3];
    const roll = () => Math.round((sMin + Math.random() * (sMax - sMin)) * 100) / 100;

    if (spec.toLowerCase() === 'random') {
      const words = [...getConceptWords()];
      const picked = [];
      const n = j.conceptsPerSession ?? 2;
      while (picked.length < n && words.length) {
        const i = Math.floor(Math.random() * words.length);
        picked.push({ word: words.splice(i, 1)[0], strength: roll() });
      }
      return picked;
    }

    const pinned = parsePinned(spec);
    if (!pinned.length) return null;
    return pinned.map((c) => ({ word: c.word, strength: c.strength ?? roll() }));
  }

  // Build data/jlens/cv-<hash>.gguf for this session's concepts.
  async makeControlVector(concepts) {
    const j = this.cfg.jlens ?? {};
    const tmp = tmpPath('cv');
    const python = path.resolve(ROOT, j.python ?? 'tools/.venv/bin/python');
    const args = [
      path.resolve(ROOT, 'tools', 'jlens_make_cv.py'),
      '--deck', path.resolve(ROOT, j.deck ?? 'data/jlens/deck.npz'),
      '--concepts', concepts.map((c) => `${c.word}:${c.strength}`).join(','),
      '--out', tmp,
    ];
    logEvent('jlens', 'building control vector', { concepts, layerRange: j.layerRange });
    if (j.layerRange) args.push('--layers', `${j.layerRange[0]}-${j.layerRange[1]}`);
    if (j.layerOffset) args.push('--layer-offset', String(j.layerOffset));
    // Self-healing: pinned concepts missing from the deck get solved and
    // appended on the fly (seconds with the solver cache) instead of erroring.
    if (j.lens) {
      args.push('--auto-add', '--lens', path.resolve(ROOT, j.lens));
      if (j.hfModel) args.push('--hf-model', j.hfModel);
    }
    try {
      const stdout = await run(python, args, 'jlens_make_cv');
      logEvent('jlens', 'make_cv ok', { stdout: stdout.trim() });
      return finalize(tmp, 'cv');
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }

  // Build data/jlens/noise-<hash>.gguf: K random vocabulary words blended with
  // random signed weights into one pulled-back direction ("sparse semantic
  // noise"). Returns { path, info: {words, weights, strength} }.
  async makeNoiseVector() {
    const j = this.cfg.jlens ?? {};
    const noise = j.noise ?? {};
    const tmp = tmpPath('noise');
    const python = path.resolve(ROOT, j.python ?? 'tools/.venv/bin/python');
    const args = [
      path.resolve(ROOT, 'tools', 'jlens_semantic_noise.py'),
      '--deck', path.resolve(ROOT, j.deck ?? 'data/jlens/deck.npz'),
      '--lens', path.resolve(ROOT, j.lens),
      '--tokens', String(noise.tokens ?? 8),
      '--strength', String(noise.strength ?? 0.25),
      '--out', tmp,
    ];
    if (j.hfModel) args.push('--hf-model', j.hfModel);
    if (j.layerRange) args.push('--layers', `${j.layerRange[0]}-${j.layerRange[1]}`);
    if (j.layerOffset) args.push('--layer-offset', String(j.layerOffset));
    try {
      const stdout = await run(python, args, 'jlens_semantic_noise');
      const m = stdout.match(/^NOISE (\{.*\})$/m);
      const info = m ? JSON.parse(m[1]) : null;
      logEvent('jlens', 'semantic noise vector built', info);
      return { path: finalize(tmp, 'noise'), info };
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }
}
