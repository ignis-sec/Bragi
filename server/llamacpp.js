import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR } from './config.js';
import { logEvent } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Manages a llama-server child process for the songwriting step, optionally
// with j-lens control vectors applied (built by jlens.js). The process is
// started per writing session and killed afterwards, which doubles as the
// VRAM handoff to ComfyUI. Only used by the "llamacpp" backend — with the
// "broker" backend an external GPU broker runs llama-server instead.
export class LlamaCppBackend {
  constructor(config) {
    this.cfg = config.llamacpp ?? {};
    this.proc = null;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.cfg.port ?? 8080}`;
  }

  async start(controlVectors = []) {
    if (this.proc) await this.stop();
    const cfg = this.cfg;
    if (!cfg.model) throw new Error('llamacpp.model is not set in config.json');
    // llama.cpp sums multiple control vector files — concepts + noise compose.
    const cvs = (Array.isArray(controlVectors) ? controlVectors : [controlVectors]).filter(Boolean);
    const args = [
      '-m', path.resolve(ROOT, cfg.model),
      '--host', '127.0.0.1',
      '--port', String(cfg.port ?? 8080),
      '-c', String(cfg.ctxSize ?? 16384),
      '--jinja',
      ...cvs.flatMap((cv) => ['--control-vector', cv]),
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
