import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load ROOT/.env (KEY=VALUE lines) into process.env; real env vars win.
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

export const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// Where finished songs live, named after the song. User-facing, so it defaults
// to a visible ./songs folder rather than data/.
export const SONGS_DIR = path.resolve(ROOT, config.storage?.songsDir ?? './songs');
