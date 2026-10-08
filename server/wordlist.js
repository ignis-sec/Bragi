import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { kvGet, kvSet } from './db.js';

// The concept words used by j-lens "random" mode. Stored in the database and
// editable from Settings > Concept list; the file in tools/ is only the seed
// for a fresh database (and the reset target). Words added here don't need to
// be in the deck — the auto-add path solves them on first use.
const KEY = 'conceptWords';

export function defaultConceptWords() {
  const file = path.resolve(ROOT, config.llamacpp?.jlens?.wordlist ?? 'tools/jlens_wordlist.txt');
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export function getConceptWords() {
  let words = kvGet(KEY);
  if (!Array.isArray(words)) {
    words = defaultConceptWords();
    kvSet(KEY, words);
  }
  return words;
}

// Sanitize: lowercase single words (letters only, as the pullback solver
// expects one leading token per word), deduped, order preserved.
export function setConceptWords(words) {
  const clean = [
    ...new Set(
      (Array.isArray(words) ? words : [])
        .map((w) => String(w).trim().toLowerCase())
        .filter((w) => /^[a-z]{2,32}$/.test(w)),
    ),
  ];
  kvSet(KEY, clean);
  return clean;
}

export function resetConceptWords() {
  const words = defaultConceptWords();
  kvSet(KEY, words);
  return words;
}
