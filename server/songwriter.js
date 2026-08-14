import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Optional sampling knobs — only sent when set; unknown fields are ignored
  // by servers that don't support them.
  if (sampling.topP != null) base.top_p = sampling.topP;
  if (sampling.topK != null) base.top_k = sampling.topK;
  if (sampling.minP != null) base.min_p = sampling.minP;
  if (sampling.repeatPenalty != null) base.repeat_penalty = sampling.repeatPenalty;
  if (ttl) base.ttl = ttl; // LM Studio JIT auto-unload; ignored elsewhere

  let { res, text } = await send({
    ...base,
    tools: [SUBMIT_SONG_TOOL],
    // Must be a string — LM Studio rejects the OpenAI object form. With a
    // single tool offered, 'required' still forces submit_song.
    tool_choice: 'required',
  });
  if (res.status === 400 && /tool/i.test(text ?? '')) {
    // Server doesn't support tools — ask for bare JSON instead.
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
    throw new Error(`Songwriter request failed (${res.status}): ${(text ?? '').slice(0, 300)}`);
  }

  const data = await res.json();
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
