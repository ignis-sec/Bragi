import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, kvGet, kvSet } from './db.js';

export { ROOT, DATA_DIR };

// config.json holds DEFAULTS only — the app never writes it. Every change made
// from the settings page is stored in the database as a dotted-path override
// and applied on top of the defaults at boot (and live, via updateConfig).
export const CONFIG_PATH = process.env.MUSE_CONFIG ?? path.join(ROOT, 'config.json');

const BAD_SEGMENT = /^(__proto__|constructor|prototype)$/;

export function setConfigPath(target, dotted, value) {
  const parts = dotted.split('.');
  if (parts.some((p) => !p || BAD_SEGMENT.test(p))) {
    throw new Error(`invalid config path: ${dotted}`);
  }
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (node[key] == null || typeof node[key] !== 'object') {
      node[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    node = node[key];
  }
  const leaf = parts[parts.length - 1];
  node[/^\d+$/.test(leaf) ? Number(leaf) : leaf] = value;
}

export const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const overrides = kvGet('configOverrides', {});
for (const [dotted, value] of Object.entries(overrides)) {
  try {
    setConfigPath(config, dotted, value);
  } catch (err) {
    console.warn('[config] skipping stored override:', err.message);
  }
}

// Apply a change-set to the live config and persist it as overrides.
export function updateConfig(changes) {
  for (const [dotted, value] of Object.entries(changes)) {
    setConfigPath(config, dotted, value);
    overrides[dotted] = value;
  }
  kvSet('configOverrides', overrides);
}

// Loading a dotted env file (.env) — real env vars win.
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env — fine
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

// Where finished songs live, named after the song.
export const SONGS_DIR = path.resolve(ROOT, config.storage?.songsDir ?? './songs');
