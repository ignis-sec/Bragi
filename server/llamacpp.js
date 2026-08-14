import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { ROOT, DATA_DIR } from './config.js';
import { logEvent } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Manages a llama-server child process for the songwriting step, optionally
// with a j-lens control vector applied. The process is started per writing
// session and killed afterwards, which doubles as the VRAM handoff to ComfyUI.
export class LlamaCppBackend {
  constructor(config) {
    this.cfg = config.llamacpp ?? {};
    this.proc = null;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.cfg.port ?? 8080}`;
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
      const words = fs
        .readFileSync(path.resolve(ROOT, j.wordlist ?? 'tools/jlens_wordlist.txt'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
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

  // Build data/jlens/current.gguf for this session's concepts.
  async makeControlVector(concepts) {
    const j = this.cfg.jlens ?? {};
    const out = path.join(DATA_DIR, 'jlens', 'current.gguf');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const python = path.resolve(ROOT, j.python ?? 'tools/.venv/bin/python');
    const args = [
      path.resolve(ROOT, 'tools', 'jlens_make_cv.py'),
      '--deck', path.resolve(ROOT, j.deck ?? 'data/jlens/deck.npz'),
      '--concepts', concepts.map((c) => `${c.word}:${c.strength}`).join(','),
      '--out', out,
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
    await new Promise((resolve, reject) => {
      execFile(python, args, (err, stdout, stderr) => {
        if (err) {
          logEvent('jlens', 'make_cv FAILED', { stderr: (stderr || err.message).trim() });
          reject(new Error(`jlens_make_cv failed: ${(stderr || err.message).trim()}`));
        } else {
          logEvent('jlens', 'make_cv ok', { stdout: stdout.trim() });
          resolve();
        }
      });
    });
    return out;
  }

  async start(controlVector) {
    if (this.proc) await this.stop();
    const cfg = this.cfg;
    if (!cfg.model) throw new Error('llamacpp.model is not set in config.json');
    const args = [
      '-m', path.resolve(ROOT, cfg.model),
      '--host', '127.0.0.1',
      '--port', String(cfg.port ?? 8080),
      '-c', String(cfg.ctxSize ?? 16384),
      '--jinja',
      ...(controlVector ? ['--control-vector', controlVector] : []),
      ...(cfg.extraArgs ?? []),
    ];
    const logPath = path.join(DATA_DIR, 'llama-server.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n--- ${new Date().toISOString()} ${cfg.serverBin ?? 'llama-server'} ${args.join(' ')}\n`);
    logEvent('llamacpp', `spawning ${cfg.serverBin ?? 'llama-server'}`, { args });
    const t0 = Date.now();
    const proc = spawn(cfg.serverBin ?? 'llama-server', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    proc.on('error', () => {}); // reported via exit checks below
    this.proc = proc;

    let exited = false;
    proc.on('exit', () => {
      exited = true;
    });
    const deadline = Date.now() + (cfg.startupTimeoutSec ?? 180) * 1000;
    while (Date.now() < deadline) {
      if (exited) {
        this.proc = null;
        throw new Error(`llama-server exited during startup — see ${logPath}`);
      }
      try {
        const res = await fetch(`${this.baseUrl}/health`);
        if (res.ok) {
          logEvent('llamacpp', `healthy in ${Math.round((Date.now() - t0) / 1000)}s`);
          return;
        }
      } catch {
        /* not up yet */
      }
      await sleep(1000);
    }
    await this.stop();
    throw new Error('llama-server did not become healthy in time');
  }

  async stop() {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    logEvent('llamacpp', 'stopping llama-server');
    await new Promise((resolve) => {
      const hardKill = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      proc.on('exit', () => {
        clearTimeout(hardKill);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }
}
