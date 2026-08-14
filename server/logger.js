import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

// Category-gated debug logging. Categories are toggled live from the
// Settings > Logging tab (config.logging.categories, read at call time).
// Entries go to an in-memory ring buffer (served at /api/logs for the
// dashboard viewer), to the console, and optionally to a file.

export const CATEGORIES = ['engine', 'prompts', 'llmResponses', 'comfy', 'jlens', 'llamacpp', 'http'];

const MAX_BUFFER = 500;
const MAX_DATA_CHARS = 16_000;

const buffer = [];
let seq = 0;

function serializeData(data) {
  if (data === undefined) return undefined;
  try {
    const json = JSON.stringify(data, null, 1);
    return json.length > MAX_DATA_CHARS ? `${json.slice(0, MAX_DATA_CHARS)}… (truncated)` : json;
  } catch {
    return String(data);
  }
}

export function logEvent(cat, msg, data) {
  const lg = config.logging ?? {};
  if (!lg.categories?.[cat]) return;

  const entry = { id: ++seq, ts: Date.now(), cat, msg, data: serializeData(data) };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const line = `[${new Date(entry.ts).toISOString()}] [${cat}] ${msg}`;
  console.log(entry.data !== undefined ? `${line}\n${entry.data}` : line);
  if (lg.toFile && lg.file) {
    fs.appendFile(
      path.resolve(ROOT, lg.file),
      entry.data !== undefined ? `${line}\n${entry.data}\n` : `${line}\n`,
      () => {},
    );
  }
}

export function getLogs(sinceId = 0) {
  return buffer.filter((e) => e.id > sinceId);
}

export function clearLogs() {
  buffer.length = 0;
}
