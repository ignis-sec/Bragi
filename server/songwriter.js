import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from './logger.js';

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompts',
  'system-prompt.md',
);

export const SUBMIT_SONG_TOOL = {
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
            'Rich prose music description in three labeled paragraphs: "Global Metadata:" (genre/era, "<N> BPM", key/mode, energy arc, production character), "Vocal Details:" (voice, delivery, harmonies, where vocals appear), "Arrangement:" (instruments and a section-by-section walk-through). 100-250 words, producer-brief register — not a tag list.',
        },
        lyrics: {
          type: 'string',
          description:
            'Full song lyrics with Title Case structure tags on their own lines ([Intro], [Verse 1], [Pre-Chorus], [Chorus], [Guitar solo], [Bridge], [Outro]), blank line between sections. Every non-tag line is sung verbatim — no stage directions and no parentheses anywhere.',
        },
      },
      required: ['song_name', 'caption', 'lyrics'],
    },
  },
};

// "ocean, rust:8" -> [{word:'ocean', strength:null}, {word:'rust', strength:8}]
export function parseConceptSpec(spec) {
  return String(spec ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [word, strength] = p.split(':');
      return { word: word.trim().toLowerCase(), strength: strength ? Number(strength) : null };
    })
    .filter((c) => c.word);
}

function buildUserMessage(guidance = {}, recentSongs = [], concepts = null) {
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

  if (concepts?.length) {
    lines.push(
      '',
      `Build the song around these concepts (let them shape imagery and theme, don't just name-drop them): ${concepts
        .map((c) => c.word)
        .join(', ')}`,
    );
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

// Fallback for Qwen's XML-style tool-call syntax, which some servers fail to
// parse into tool_calls and leave as raw text (often in reasoning_content):
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

function parseSongFromMessage(msg) {
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
  return args;
}

// Optional sampling knobs — only sent when set; unknown fields are ignored
// by servers that don't support them.
function applySampling(body, sampling = {}) {
  if (sampling.topP != null) body.top_p = sampling.topP;
  if (sampling.topK != null) body.top_k = sampling.topK;
  if (sampling.minP != null) body.min_p = sampling.minP;
  if (sampling.repeatPenalty != null) body.repeat_penalty = sampling.repeatPenalty;
}

const SUBMIT_COVER_TOOL = {
  type: 'function',
  function: {
    name: 'submit_cover_prompt',
    description:
      'Submit the finished image-generation prompt for the album cover. Must be called exactly once.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Very descriptive natural-language description of the image contents and style — subject, scene, composition, palette, lighting, mood — framed as album cover art.',
        },
      },
      required: ['prompt'],
    },
  },
};

// Ask the model for an album-cover image prompt via a forced tool call, with
// the same fallback ladder as songwriting (XML tool syntax, bare JSON, and
// finally the raw reply text).
export async function requestCoverPrompt({
  baseUrl,
  apiKey,
  model,
  sampling = {},
  system,
  user,
  maxTokens = 2048,
  ttl,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const base = { model, messages, temperature: sampling.temperature ?? 0.8, max_tokens: maxTokens };
  applySampling(base, sampling);
  if (ttl) base.ttl = ttl;

  const send = async (body) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { res, text: res.ok ? null : await res.text().catch(() => '') };
  };

  logEvent('prompts', `cover-prompt request -> ${baseUrl}`, { system, user });
  const t0 = Date.now();
  let { res, text } = await send({
    ...base,
    tools: [SUBMIT_COVER_TOOL],
    tool_choice: 'required',
  });
  if (res.status === 400 && /tool/i.test(text ?? '')) {
    logEvent('llmResponses', `tools rejected (${res.status}) — retrying without tools`, { text });
    ({ res, text } = await send({
      ...base,
      messages: [
        {
          role: 'system',
          content: `${system}\n\nIMPORTANT: function calling is unavailable — respond with ONLY the image prompt text, nothing else.`,
        },
        messages[1],
      ],
    }));
  }
  if (!res.ok) {
    logEvent('llmResponses', `cover-prompt request FAILED (${res.status})`, { text });
    throw new Error(`Cover prompt request failed (${res.status}): ${(text ?? '').slice(0, 300)}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  logEvent('llmResponses', `cover-prompt response in ${Date.now() - t0}ms`, { message: msg });

  let prompt = null;
  const call =
    msg.tool_calls?.find((c) => c.function?.name === 'submit_cover_prompt') ?? msg.tool_calls?.[0];
  if (call?.function?.arguments) {
    try {
      prompt = JSON.parse(call.function.arguments).prompt;
    } catch {
      prompt = extractJsonObject(call.function.arguments)?.prompt;
    }
  }
  if (!prompt) {
    for (const t of [msg.content, msg.reasoning_content].filter(Boolean)) {
      const args = extractXmlToolCall(t) ?? extractJsonObject(t);
      if (args?.prompt) {
        prompt = args.prompt;
        break;
      }
    }
  }
  if (!prompt) {
    // Last resort: a plain-text reply IS the prompt (never the reasoning).
    const raw = String(msg.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    if (raw) prompt = raw;
  }
  if (!prompt || !String(prompt).trim()) {
    throw new Error('The art director returned no image prompt');
  }
  return String(prompt).trim();
}

// One songwriting request against any OpenAI-compatible chat endpoint
// (LM Studio or llama-server). Falls back to tool-free JSON output if the
// server rejects the tools/tool_choice fields.
export async function requestSong({
  baseUrl,
  apiKey,
  model,
  temperature,
  sampling = {},
  ttl,
  guidance,
  recentSongs,
  concepts,
}) {
  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildUserMessage(guidance, recentSongs, concepts) },
  ];

  const send = async (body) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { res, text: res.ok ? null : await res.text().catch(() => '') };
  };

  // Cap output so a derailed generation (e.g. an overdosed j-lens injection
  // chanting one word) fails fast instead of rambling to the context limit.
  const base = {
    model,
    messages,
    temperature: sampling.temperature ?? temperature ?? 0.9,
    max_tokens: 4096,
  };
  applySampling(base, sampling);
  if (ttl) base.ttl = ttl; // LM Studio JIT auto-unload; ignored elsewhere

  logEvent('prompts', `songwriter request -> ${baseUrl}`, {
    model,
    sampling: { ...base, messages: undefined },
    system: messages[0].content,
    user: messages[1].content,
  });
  const t0 = Date.now();

  let { res, text } = await send({
    ...base,
    tools: [SUBMIT_SONG_TOOL],
    // Must be a string — LM Studio rejects the OpenAI object form. With a
    // single tool offered, 'required' still forces submit_song.
    tool_choice: 'required',
  });
  if (res.status === 400 && /tool/i.test(text ?? '')) {
    // Server doesn't support tools — ask for bare JSON instead.
    logEvent('llmResponses', `tools rejected (${res.status}) — retrying without tools`, { text });
    const jsonMessages = [
      {
        role: 'system',
        content: `${systemPrompt}\n\nIMPORTANT: function calling is unavailable — respond with ONLY a single JSON object with keys "song_name", "caption", "lyrics". No other text.`,
      },
      messages[1],
    ];
    ({ res, text } = await send({ ...base, messages: jsonMessages }));
  }
  if (!res.ok) {
    logEvent('llmResponses', `songwriter request FAILED (${res.status})`, { text });
    throw new Error(`Songwriter request failed (${res.status}): ${(text ?? '').slice(0, 300)}`);
  }

  const data = await res.json();
  logEvent('llmResponses', `songwriter response in ${Date.now() - t0}ms`, {
    message: data.choices?.[0]?.message,
    usage: data.usage,
  });
  const args = parseSongFromMessage(data.choices?.[0]?.message);
  if (!args) throw new Error('The songwriter did not return a submit_song call');

  const name = String(args.song_name ?? args.name ?? '').trim();
  const caption = String(args.caption ?? '').trim();
  const lyrics = String(args.lyrics ?? '').trim();
  if (!caption || !lyrics) {
    throw new Error('The songwriter returned an incomplete song (missing caption or lyrics)');
  }
  return { name: name || 'Untitled', caption, lyrics };
}
