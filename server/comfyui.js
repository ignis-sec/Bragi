import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, SONGS_DIR } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Neon Skyline" -> "Neon Skyline.mp3", deduped against existing files.
export function songFilename(name, ext) {
  const base =
    String(name ?? '')
      .replace(/[/\\:*?"<>|\x00-\x1f]/g, '')
      .trim()
      .slice(0, 120) || 'Untitled';
  let file = `${base}${ext}`;
  for (let n = 2; fs.existsSync(path.join(SONGS_DIR, file)); n++) {
    file = `${base} (${n})${ext}`;
  }
  return file;
}

// Replace ${caption} / ${lyrics} placeholders anywhere in the workflow.
// Works on the parsed JSON tree, so quotes/newlines in the values stay safe.
export function substitute(node, vars) {
  if (typeof node === 'string') {
    return node.replace(/\$\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, vars));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return node;
}

// Apply settings-page overrides onto the workflow, matched by class_type so
// node renumbering in a re-exported workflow doesn't break them. Only values
// that are set (non-null, non-empty) override the template.
export function applyOverrides(prompt, o = {}) {
  const set = (inputs, key, value) => {
    if (value !== null && value !== undefined && value !== '') inputs[key] = value;
  };
  for (const node of Object.values(prompt)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    switch (node.class_type) {
      case 'MiniMaxMusic3TextEncode':
        set(inputs, 'max_duration', o.maxDuration);
        set(inputs, 'cfg_scale', o.encodeCfgScale);
        set(inputs, 'top_k', o.encodeTopK);
        break;
      case 'KSampler':
        set(inputs, 'steps', o.steps);
        set(inputs, 'cfg', o.cfg);
        set(inputs, 'sampler_name', o.samplerName);
        set(inputs, 'scheduler', o.scheduler);
        break;
      case 'UNETLoader':
        set(inputs, 'unet_name', o.unetName);
        break;
      case 'CLIPLoader':
        set(inputs, 'clip_name', o.clipName);
        break;
      case 'VAELoader':
        set(inputs, 'vae_name', o.vaeName);
        break;
    }
  }
}

// Fresh seed every run so identical prompts still give different songs.
function randomizeSeeds(prompt) {
  for (const node of Object.values(prompt)) {
    if (node?.inputs && typeof node.inputs.seed === 'number') {
      node.inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }
  }
}

function findAudioOutput(outputs = {}) {
  for (const nodeOutput of Object.values(outputs)) {
    const audio = nodeOutput?.audio?.[0];
    if (audio?.filename) return audio;
  }
  return null;
}

function comfyErrorMessage(entry) {
  const msgs = entry?.status?.messages ?? [];
  for (const [type, data] of msgs) {
    if (type === 'execution_error') {
      return `${data?.node_type ?? '?'}: ${data?.exception_message ?? 'unknown error'}`;
    }
  }
  return entry?.status?.status_str ?? 'unknown error';
}

// Ask ComfyUI to unload its cached models and free VRAM so the LLM can load.
// Mirror of unloadModel() in lmstudio.js. Non-fatal: ComfyUI may simply not be
// up yet, and the Qwen step doesn't need it running.
export async function freeComfy(config) {
  try {
    const res = await fetch(`${config.comfyui.baseUrl}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    // The unload runs in ComfyUI's executor loop — give the VRAM a moment to
    // actually come back before the LLM tries to claim it.
    await sleep(config.comfyui.freeWaitMs ?? 5000);
  } catch (err) {
    console.warn('[comfyui] could not free ComfyUI models:', err.message);
  }
}

// Best effort: drop the prompt if it's still queued, interrupt it if running.
async function cancelPrompt(cfg, promptId) {
  try {
    await fetch(`${cfg.baseUrl}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    await fetch(`${cfg.baseUrl}/interrupt`, { method: 'POST' });
  } catch (err) {
    console.warn('[comfyui] could not cancel prompt:', err.message);
  }
}

export async function renderSong(config, { name, caption, lyrics }, { signal } = {}) {
  const cfg = config.comfyui;
  const workflowPath = path.resolve(ROOT, cfg.workflow);
  const template = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const prompt = substitute(template, { caption, lyrics });
  applyOverrides(prompt, cfg.workflowOverrides);
  randomizeSeeds(prompt);

  const res = await fetch(`${cfg.baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: crypto.randomUUID() }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ComfyUI rejected the workflow (${res.status}): ${text.slice(0, 400)}`);
  }
  const { prompt_id: promptId } = await res.json();
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  const deadline = Date.now() + (cfg.timeoutMinutes ?? 30) * 60_000;
  while (true) {
    if (signal?.aborted) {
      await cancelPrompt(cfg, promptId);
      const err = new Error('Render cancelled');
      err.cancelled = true;
      throw err;
    }
    if (Date.now() > deadline) throw new Error('ComfyUI generation timed out');
    await sleep(cfg.pollIntervalMs ?? 3000);

    const hist = await fetch(`${cfg.baseUrl}/history/${promptId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const entry = hist?.[promptId];
    if (!entry) continue; // still queued or running

    if (entry.status?.status_str === 'error') {
      throw new Error(`ComfyUI failed: ${comfyErrorMessage(entry)}`);
    }
    if (entry.status?.completed || Object.keys(entry.outputs ?? {}).length) {
      const audio = findAudioOutput(entry.outputs);
      if (!audio) throw new Error('ComfyUI finished but produced no audio output');
      return await download(cfg, audio, name);
    }
  }
}

async function download(cfg, audio, name) {
  const params = new URLSearchParams({
    filename: audio.filename,
    subfolder: audio.subfolder ?? '',
    type: audio.type ?? 'output',
  });
  const res = await fetch(`${cfg.baseUrl}/view?${params}`);
  if (!res.ok) throw new Error(`Could not download audio from ComfyUI (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(audio.filename) || '.mp3';
  const file = songFilename(name, ext);
  fs.writeFileSync(path.join(SONGS_DIR, file), buf);
  return { file };
}
