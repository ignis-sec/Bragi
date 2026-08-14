import { execFile } from 'node:child_process';
import { requestSong } from './songwriter.js';

export async function generateSongMeta(config, guidance, recentSongs, concepts = null) {
  const lm = config.lmstudio;
  return requestSong({
    baseUrl: lm.baseUrl,
    apiKey: process.env.LLM_API_KEY,
    model: lm.model,
    temperature: lm.temperature,
    ttl: lm.ttlSeconds,
    guidance,
    recentSongs,
    concepts,
  });
}

// Unload the LLM so the GPU is free for ComfyUI.
// "cli"  -> run `lms unload --all` (needs the LM Studio CLI on PATH)
// "ttl"  -> rely on the ttl passed with each request, do nothing here
// "none" -> do nothing
export async function unloadModel(config) {
  const mode = config.lmstudio.unload ?? 'cli';
  if (mode !== 'cli') return;
  await new Promise((resolve) => {
    execFile('lms', ['unload', '--all'], (err, _stdout, stderr) => {
      if (err) {
        console.warn(
          '[lmstudio] `lms unload --all` failed (is the lms CLI installed?):',
          (stderr || err.message).trim(),
        );
      }
      resolve();
    });
  });
}
