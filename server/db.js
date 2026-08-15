import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// BRAGI_DATA overrides the data dir (used by tests to keep the real db safe).
const dataOverride = process.env.BRAGI_DATA ?? process.env.MUSE_DATA;
export const DATA_DIR = dataOverride ? path.resolve(dataOverride) : path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// One-time rename from the app's pre-release name.
const DB_FILE = path.join(DATA_DIR, 'bragi.db');
const OLD_DB_FILE = path.join(DATA_DIR, 'muse.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(OLD_DB_FILE)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(OLD_DB_FILE + suffix)) {
      fs.renameSync(OLD_DB_FILE + suffix, DB_FILE + suffix);
    }
  }
  console.log('[db] renamed muse.db -> bragi.db');
}

// Single app database: live settings, config overrides, and all player state.
// The JSON files (config.json, the old data/db.json) are defaults/legacy only.
export const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS songs (
    position INTEGER PRIMARY KEY,
    data     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drafts (
    position INTEGER PRIMARY KEY,
    data     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS queue (
    position INTEGER PRIMARY KEY,
    song_id  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id   TEXT NOT NULL,
    played_at INTEGER NOT NULL
  );
`);

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function kvSet(key, value) {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}
