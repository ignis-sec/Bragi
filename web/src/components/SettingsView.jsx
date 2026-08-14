import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiText } from '../api.js';

const LOG_CATEGORIES = [
  { key: 'engine', hint: 'Loop lifecycle: phases, sessions, drafts, errors' },
  { key: 'prompts', hint: 'Full prompts sent to the songwriter LLM' },
  { key: 'llmResponses', hint: 'Raw LLM responses (tool calls, content, usage)' },
  { key: 'comfy', hint: 'ComfyUI dispatches, renders, /free calls' },
  { key: 'jlens', hint: 'Concept picks, control-vector builds, auto-adds' },
  { key: 'llamacpp', hint: 'llama-server spawn/health/stop' },
  { key: 'http', hint: 'Dashboard API requests and bodies' },
];

const LOGGING_SECTION = {
  title: 'Log categories',
  fields: [
    { path: 'logging.toFile', label: 'Also write to file', type: 'bool' },
    { path: 'logging.file', label: 'Log file', type: 'text' },
    ...LOG_CATEGORIES.map(({ key, hint }) => ({
      path: `logging.categories.${key}`,
      label: key,
      type: 'bool',
      hint,
    })),
  ],
};

// Schema-driven settings form. Each field maps a dotted config path to an
// input. Types: text, number, bool, select, args (space-separated -> array).
const SECTIONS = [
  {
    title: 'Songwriter',
    fields: [
      { path: 'llm.backend', label: 'Backend', type: 'select', options: ['lmstudio', 'llamacpp'], hint: 'Applies from the next writing session' },
      { path: 'generation.draftLookahead', label: 'Draft lookahead', type: 'number', hint: 'Editable drafts kept waiting during renders' },
      { path: 'generation.maxQueuedSongs', label: 'Max queued songs', type: 'number', hint: 'Loop pauses when this many rendered songs wait' },
    ],
  },
  {
    title: 'LM Studio',
    fields: [
      { path: 'lmstudio.baseUrl', label: 'Base URL', type: 'text' },
      { path: 'lmstudio.model', label: 'Model id', type: 'text' },
      { path: 'lmstudio.ttlSeconds', label: 'JIT TTL (s)', type: 'number' },
      { path: 'lmstudio.unload', label: 'Unload via', type: 'select', options: ['cli', 'ttl', 'none'] },
      { path: 'lmstudio.temperature', label: 'Temperature', type: 'number' },
      { path: 'lmstudio.topP', label: 'top_p', type: 'number', optional: true },
      { path: 'lmstudio.topK', label: 'top_k', type: 'number', optional: true },
      { path: 'lmstudio.minP', label: 'min_p', type: 'number', optional: true },
      { path: 'lmstudio.repeatPenalty', label: 'repeat_penalty', type: 'number', optional: true },
    ],
  },
  {
    title: 'llama.cpp',
    fields: [
      { path: 'llamacpp.serverBin', label: 'llama-server binary', type: 'text' },
      { path: 'llamacpp.model', label: 'GGUF model path', type: 'text' },
      { path: 'llamacpp.port', label: 'Port', type: 'number' },
      { path: 'llamacpp.ctxSize', label: 'Context size', type: 'number' },
      { path: 'llamacpp.extraArgs', label: 'Extra args', type: 'args', hint: 'Space-separated, e.g. -ngl 99 --n-cpu-moe 40' },
      { path: 'llamacpp.startupTimeoutSec', label: 'Startup timeout (s)', type: 'number' },
      { path: 'llamacpp.temperature', label: 'Temperature', type: 'number' },
      { path: 'llamacpp.topP', label: 'top_p', type: 'number', optional: true },
      { path: 'llamacpp.topK', label: 'top_k', type: 'number', optional: true },
      { path: 'llamacpp.minP', label: 'min_p', type: 'number', optional: true },
      { path: 'llamacpp.repeatPenalty', label: 'repeat_penalty', type: 'number', optional: true },
    ],
  },
  {
    title: 'j-lens concept injection',
    fields: [
      { path: 'llamacpp.jlens.enabled', label: 'Enabled', type: 'bool' },
      { path: 'llamacpp.jlens.strengthRange.0', label: 'Default strength (min)', type: 'number', hint: 'Rolled per concept when no :strength given' },
      { path: 'llamacpp.jlens.strengthRange.1', label: 'Default strength (max)', type: 'number' },
      { path: 'llamacpp.jlens.layerRange.0', label: 'Inject from layer', type: 'number' },
      { path: 'llamacpp.jlens.layerRange.1', label: 'Inject to layer', type: 'number' },
      { path: 'llamacpp.jlens.layerOffset', label: 'Layer offset', type: 'number' },
      { path: 'llamacpp.jlens.conceptsPerSession', label: 'Concepts per session ("random" mode)', type: 'number' },
      { path: 'llamacpp.jlens.noise.tokens', label: 'Noise: tokens blended', type: 'number', hint: 'Random words mixed into the semantic-noise direction' },
      { path: 'llamacpp.jlens.noise.strength', label: 'Noise: strength', type: 'number', hint: 'Injection strength of the blended direction' },
      { path: 'llamacpp.jlens.mentionInPrompt', label: 'Also mention concepts in prompt', type: 'bool' },
      { path: 'llamacpp.jlens.lens', label: 'Lens file (.pt)', type: 'text' },
      { path: 'llamacpp.jlens.hfModel', label: 'HF model (for auto-add)', type: 'text' },
      { path: 'llamacpp.jlens.wordlist', label: 'Wordlist file', type: 'text' },
      { path: 'llamacpp.jlens.deck', label: 'Deck file', type: 'text' },
    ],
  },
  {
    title: 'ComfyUI',
    fields: [
      { path: 'comfyui.baseUrl', label: 'Base URL', type: 'text' },
      { path: 'comfyui.workflow', label: 'Workflow template', type: 'text' },
      { path: 'comfyui.pollIntervalMs', label: 'Poll interval (ms)', type: 'number' },
      { path: 'comfyui.timeoutMinutes', label: 'Render timeout (min)', type: 'number' },
      { path: 'comfyui.freeWaitMs', label: 'VRAM settle wait (ms)', type: 'number' },
    ],
  },
  {
    title: 'Music generation (workflow overrides)',
    fields: [
      { path: 'comfyui.workflowOverrides.maxDuration', label: 'Max duration (s)', type: 'number' },
      { path: 'comfyui.workflowOverrides.steps', label: 'Diffusion steps', type: 'number' },
      { path: 'comfyui.workflowOverrides.cfg', label: 'KSampler CFG', type: 'number' },
      { path: 'comfyui.workflowOverrides.encodeCfgScale', label: 'Text encode CFG scale', type: 'number' },
      { path: 'comfyui.workflowOverrides.encodeTopK', label: 'Text encode top_k', type: 'number' },
      { path: 'comfyui.workflowOverrides.samplerName', label: 'Sampler', type: 'text' },
      { path: 'comfyui.workflowOverrides.scheduler', label: 'Scheduler', type: 'text' },
      { path: 'comfyui.workflowOverrides.unetName', label: 'Diffusion model (UNET)', type: 'text' },
      { path: 'comfyui.workflowOverrides.clipName', label: 'Text encoder (CLIP)', type: 'text' },
      { path: 'comfyui.workflowOverrides.vaeName', label: 'VAE', type: 'text' },
    ],
  },
  {
    title: 'Server & storage',
    fields: [
      { path: 'server.port', label: 'Dashboard port', type: 'number', restart: true },
      { path: 'storage.songsDir', label: 'Songs folder', type: 'text', restart: true },
    ],
  },
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((n, p) => n?.[/^\d+$/.test(p) ? Number(p) : p], obj);
}

function Field({ field, value, onChange }) {
  const { label, type, options, hint, restart, optional } = field;
  let input;
  if (type === 'bool') {
    input = (
      <button className={`switch small ${value ? 'on' : ''}`} onClick={() => onChange(!value)}>
        <span className="knob" />
      </button>
    );
  } else if (type === 'select') {
    input = (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (type === 'number') {
    input = (
      <input
        type="number"
        step="any"
        value={value ?? ''}
        placeholder={optional ? 'unset' : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  } else if (type === 'args') {
    input = (
      <input
        value={Array.isArray(value) ? value.join(' ') : (value ?? '')}
        onChange={(e) => onChange(e.target.value.split(/\s+/).filter(Boolean))}
      />
    );
  } else {
    input = <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <label className="g-field settings-field">
      <span>
        {label}
        {restart && <em className="restart-tag">restart</em>}
      </span>
      {input}
      {hint && <small className="g-hint">{hint}</small>}
    </label>
  );
}

function PromptEditor() {
  const [text, setText] = useState(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    apiText('/api/system-prompt').then(setText).catch(() => setStatus('failed to load'));
  }, []);
  const save = async () => {
    setStatus('saving…');
    try {
      await apiText('/api/system-prompt', { method: 'PUT', body: text });
      setStatus('saved — applies to the next song');
    } catch (err) {
      setStatus(`save failed: ${err.message}`);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Qwen system prompt</h2>
          <div className="card-sub">Read fresh on every generation — no restart needed.</div>
        </div>
        <div className="card-head-actions">
          <span className="save-state">{status}</span>
          <button className="pill-btn" onClick={save} disabled={text == null}>
            Save prompt
          </button>
        </div>
      </div>
      {text == null ? (
        <div className="draft-empty">Loading…</div>
      ) : (
        <textarea
          className="lyrics-input prompt-editor"
          rows={24}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
    </section>
  );
}

function LogViewer() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState(null); // category or null = all
  const [paused, setPaused] = useState(false);
  const latestRef = useRef(0);
  const scrollRef = useRef(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (!alive || pausedRef.current) return;
      try {
        const { entries: fresh } = await api(`/api/logs?since=${latestRef.current}`);
        if (fresh.length && alive) {
          latestRef.current = fresh[fresh.length - 1].id;
          setEntries((prev) => [...prev, ...fresh].slice(-500));
        }
      } catch {
        /* server briefly away — keep polling */
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, filter]);

  const clear = async () => {
    await api('/api/logs/clear', { method: 'POST' }).catch(() => {});
    setEntries([]);
  };

  const shown = filter ? entries.filter((e) => e.cat === filter) : entries;
  const cats = ['all', ...LOG_CATEGORIES.map((c) => c.key)];

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Live log</h2>
          <div className="card-sub">
            Last 500 entries from enabled categories. Save category changes above to take effect.
          </div>
        </div>
        <div className="card-head-actions">
          <button className="pill-btn" onClick={() => setPaused(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="pill-btn" onClick={clear}>
            Clear
          </button>
        </div>
      </div>
      <div className="log-filters">
        {cats.map((c) => (
          <button
            key={c}
            className={`log-chip cat-${c} ${(filter ?? 'all') === c ? 'active' : ''}`}
            onClick={() => setFilter(c === 'all' ? null : c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="log-scroll" ref={scrollRef}>
        {shown.length === 0 ? (
          <div className="draft-empty">
            Nothing yet — enable categories above and let the loop run.
          </div>
        ) : (
          shown.map((e) => (
            <div className="log-row" key={e.id}>
              <span className="log-time">
                {new Date(e.ts).toLocaleTimeString('en-GB')}
              </span>
              <span className={`log-chip cat-${e.cat}`}>{e.cat}</span>
              <div className="log-body">
                <div className="log-msg">{e.msg}</div>
                {e.data && (
                  <details>
                    <summary>data</summary>
                    <pre>{e.data}</pre>
                  </details>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function SettingsView() {
  const [saved, setSaved] = useState(null); // config as on the server
  const [edits, setEdits] = useState({}); // dotted path -> new value
  const [status, setStatus] = useState('');
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [tab, setTab] = useState('general');

  useEffect(() => {
    api('/api/config').then(setSaved).catch(() => setStatus('failed to load config'));
  }, []);

  const dirty = Object.keys(edits).length > 0;
  const valueFor = (path) => (path in edits ? edits[path] : getPath(saved, path));

  const save = async () => {
    setStatus('saving…');
    try {
      const { restartRequired } = await api('/api/config', { method: 'PATCH', body: edits });
      if (restartRequired?.length) setRestartNeeded(true);
      setSaved(await api('/api/config'));
      setEdits({});
      setStatus('saved');
    } catch (err) {
      setStatus(`save failed: ${err.message}`);
    }
  };

  const sections = useMemo(() => SECTIONS, []);
  if (!saved) return <div className="draft-empty">Loading configuration…</div>;

  return (
    <div className="settings">
      <div className="settings-bar card">
        <div>
          <h2>Settings</h2>
          <div className="settings-tabs">
            <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
              General
            </button>
            <button className={tab === 'logging' ? 'active' : ''} onClick={() => setTab('logging')}>
              Logging
            </button>
          </div>
          <div className="card-sub">
            Config changes hot-apply to the next writing session / render.
            {restartNeeded && (
              <span className="status-error"> Some saved changes need a server restart.</span>
            )}
          </div>
        </div>
        <div className="card-head-actions">
          <span className="save-state">{status}</span>
          {dirty && (
            <button className="pill-btn" onClick={() => setEdits({})}>
              Discard
            </button>
          )}
          <button className="pill-btn accent" onClick={save} disabled={!dirty}>
            Save changes{dirty ? ` (${Object.keys(edits).length})` : ''}
          </button>
        </div>
      </div>

      {(tab === 'general' ? sections : [LOGGING_SECTION]).map((section) => (
        <section className="card" key={section.title}>
          <div className="card-head">
            <h2>{section.title}</h2>
          </div>
          <div className="settings-grid">
            {section.fields.map((field) => (
              <Field
                key={field.path}
                field={field}
                value={valueFor(field.path)}
                onChange={(v) => setEdits((e) => ({ ...e, [field.path]: v }))}
              />
            ))}
          </div>
        </section>
      ))}

      {tab === 'general' && <PromptEditor />}
      {tab === 'logging' && <LogViewer />}
    </div>
  );
}
