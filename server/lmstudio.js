import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompts',
  'system-prompt.md',
);

const SUBMIT_SONG_TOOL = {
  type: 'function',
  function: {
    name: 'submit_song',
    description:
      'Submit the one complete generated song. Must be called exactly once per request, with all three fields filled in.',
    parameters: {
      type: 'object',
      properties: {
        song_name: {
          type: 'string',
          description: 'Short evocative song title, 1-6 words, Title Case, no quotes.',
        },
        caption: {
          type: 'string',
          description:
            'One line of comma-separated music metadata tags: genre(s), mood, instruments, vocal type, "<number> bpm", production tags. Lowercase, no sentences.',
        },
        lyrics: {
          type: 'string',
          description:
            'Full song lyrics with [intro]/[verse]/[pre-chorus]/[chorus]/[bridge]/[outro] structure tags on their own lines, blank line between sections.',
        },
      },
      required: ['song_name', 'caption', 'lyrics'],
    },
  },
};

function buildUserMessage(guidance = {}, recentSongs = []) {
  const lines = ['Write the next song.'];
  const constraints = [];
  if (guidance.genre) constraints.push(`Genre/style: ${guidance.genre}`);
  if (guidance.bpm) constraints.push(`Tempo: ${guidance.bpm} bpm — use this exact bpm in the caption`);
  if (guidance.mood) constraints.push(`Mood: ${guidance.mood}`);
  if (guidance.instruments) constraints.push(`Instruments to feature: ${guidance.instruments}`);
  if (guidance.vocals) constraints.push(`Vocal type: ${guidance.vocals}`);
  if (guidance.language) constraints.push(`Lyrics language: ${guidance.language}`);
  if (guidance.extra) constraints.push(`Extra instructions: ${guidance.extra}`);

  if (constraints.length) {
    lines.push('', 'The listener asked for:', ...constraints.map((c) => `- ${c}`));
  } else {
    lines.push('', 'No constraints this time — pick a direction yourself and surprise the listener.');
  }

  if (recentSongs.length) {
    lines.push(
      '',
      'Recent songs (write something clearly different from all of these):',
      ...recentSongs.map((s) => `- "${s.name}" (${s.caption})`),
    );
  }
  return lines.join('\n');
}

// Fallback for Qwen's XML-style tool-call syntax, which LM Studio sometimes
// fails to parse into tool_calls and leaves as raw text (often in
// reasoning_content):
//   <tool_call><function=submit_song>
//   <parameter=song_name>...</parameter>...
function extractXmlToolCall(text) {
  const fn = text.match(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/);
  if (!fn) return null;
  const args = {};
  const re = /<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
  let m;
  while ((m = re.exec(fn[2]))) args[m[1]] = m[2];
  return Object.keys(args).length ? args : null;
}

// Fallback for models that answer with JSON in content instead of a tool call.
function extractJsonObject(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function generateSongMeta(config, guidance, recentSongs) {
  const lm = config.lmstudio;
  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const body = {
    model: lm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(guidance, recentSongs) },
    ],
    tools: [SUBMIT_SONG_TOOL],
    // LM Studio only accepts string values here (none/auto/required) — with a
    // single tool offered, 'required' still forces submit_song.
    tool_choice: 'required',
    temperature: lm.temperature ?? 0.9,
  };
  // LM Studio JIT auto-unload: the model unloads itself after this many idle seconds.
  if (lm.ttlSeconds) body.ttl = lm.ttlSeconds;

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;

  const res = await fetch(`${lm.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LM Studio request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;

  let args = null;
  const call =
    msg?.tool_calls?.find((c) => c.function?.name === 'submit_song') ?? msg?.tool_calls?.[0];
  if (call?.function?.arguments) {
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = extractJsonObject(call.function.arguments);
    }
  }
  if (!args) {
    for (const text of [msg?.content, msg?.reasoning_content].filter(Boolean)) {
      args = extractXmlToolCall(text) ?? extractJsonObject(text);
      if (args) break;
    }
  }
  if (!args) throw new Error('Qwen did not return a submit_song call');

  const name = String(args.song_name ?? args.name ?? '').trim();
  const caption = String(args.caption ?? '').trim();
  const lyrics = String(args.lyrics ?? '').trim();
  if (!caption || !lyrics) {
    throw new Error('Qwen returned an incomplete song (missing caption or lyrics)');
  }
  return { name: name || 'Untitled', caption, lyrics };
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
