import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { HomeIcon, ClockIcon, HeartIcon, NoteIcon, GearIcon } from '../icons.jsx';

const PHASE_LABELS = {
  idle: 'Idle',
  'queue-full': 'Queue full — waiting for you to listen',
  'unloading-comfy': 'Unloading ComfyUI models…',
  'starting-llm': 'Starting the songwriter…',
  'writing-draft': 'Qwen is writing the next song…',
  'unloading-llm': 'Stopping the songwriter…',
  'rendering-audio': 'ComfyUI is rendering audio…',
  error: 'Error — retrying shortly',
};

function EngineStatus({ state }) {
  const { engine, loopEnabled, lastError, generating } = state;
  let label = loopEnabled ? (PHASE_LABELS[engine?.phase] ?? engine?.phase) : 'Loop is off';
  if (engine?.phase === 'rendering-audio' && generating?.name) {
    label = `Rendering “${generating.name}”…`;
  }
  const busy = loopEnabled && !['idle', 'queue-full', 'error'].includes(engine?.phase);
  const session = state.session;
  return (
    <div className="engine-status">
      <span className={`status-dot ${loopEnabled ? (busy ? 'busy' : 'on') : 'off'}`} />
      <div>
        <div className="status-label">{label}</div>
        {session?.concepts?.length > 0 && (
          <div className="status-concepts">
            {session.injected ? 'Injecting: ' : 'Seeding: '}
            {session.concepts
              .map((c) => (c.strength != null ? `${c.word} ×${c.strength}` : c.word))
              .join(', ')}
          </div>
        )}
        {lastError && <div className="status-error">{lastError}</div>}
      </div>
    </div>
  );
}

function GuidancePanel({ state }) {
  const [buf, setBuf] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    setBuf((prev) => prev ?? { ...state.guidance });
  }, [state.guidance]);

  if (!buf) return null;

  const update = (key, value) => {
    const next = { ...buf, [key]: value };
    setBuf(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api('/api/guidance', { method: 'PATCH', body: next }).catch(() => {});
    }, 600);
  };

  const field = (key, label, placeholder) => (
    <label className="g-field">
      <span>{label}</span>
      <input
        value={buf[key]}
        placeholder={placeholder}
        onChange={(e) => update(key, e.target.value)}
      />
    </label>
  );

  return (
    <div className="guidance">
      <div className="panel-title">Guide the generation</div>
      {field('genre', 'Genre', 'e.g. synthwave, jazz…')}
      {field('bpm', 'BPM', 'e.g. 180')}
      {field('mood', 'Mood', 'e.g. melancholic, euphoric')}
      {field('instruments', 'Instruments', 'e.g. piano, 808s')}
      <label className="g-field">
        <span>Vocals</span>
        <select value={buf.vocals} onChange={(e) => update('vocals', e.target.value)}>
          <option value="">model's choice</option>
          <option value="female vocals">female vocals</option>
          <option value="male vocals">male vocals</option>
          <option value="duet">duet</option>
          <option value="instrumental">instrumental</option>
        </select>
      </label>
      {field('language', 'Language', 'e.g. English, Turkish')}
      {field('concepts', 'Concept seeds (j-lens)', 'off — ocean, rust:0.2, or "random"')}
      <label className="g-field">
        <span>Extra instructions</span>
        <textarea
          rows={3}
          value={buf.extra}
          placeholder="Anything else… themes, references, structure"
          onChange={(e) => update('extra', e.target.value)}
        />
      </label>
      <div className="g-hint">Applies to the next songs Qwen writes.</div>
    </div>
  );
}

function ToggleRow({ title, hint, on, onToggle }) {
  return (
    <div className="loop-row">
      <div>
        <div className="panel-title">{title}</div>
        <div className="g-hint">{hint}</div>
      </div>
      <button className={`switch ${on ? 'on' : ''}`} aria-label={`Toggle ${title}`} onClick={onToggle}>
        <span className="knob" />
      </button>
    </div>
  );
}

export default function Sidebar({ state, view, setView }) {
  const navItem = (id, icon, label) => (
    <button className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => setView(id)}>
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="side-card">
        <div className="logo">
          <NoteIcon size={26} />
          <span>Muse</span>
        </div>
        <nav>
          {navItem('home', <HomeIcon size={20} />, 'Home')}
          {navItem('history', <ClockIcon size={20} />, 'History')}
          {navItem('bookmarks', <HeartIcon size={20} />, 'Bookmarks')}
          {navItem('settings', <GearIcon size={20} />, 'Settings')}
        </nav>
      </div>

      <div className="side-card grow">
        <ToggleRow
          title="Generation loop"
          hint="Keeps writing &amp; rendering new songs"
          on={state.loopEnabled}
          onToggle={() =>
            api('/api/loop', { method: 'POST', body: { enabled: !state.loopEnabled } }).catch(
              () => {},
            )
          }
        />
        <ToggleRow
          title="Autoplay"
          hint="Start playing when a song hits the queue"
          on={state.settings?.autoplay}
          onToggle={() =>
            api('/api/settings', {
              method: 'PATCH',
              body: { autoplay: !state.settings?.autoplay },
            }).catch(() => {})
          }
        />
        <ToggleRow
          title="Pad from bookmarks"
          hint="Empty queue? Play a random bookmarked song"
          on={state.settings?.padFromBookmarks}
          onToggle={() =>
            api('/api/settings', {
              method: 'PATCH',
              body: { padFromBookmarks: !state.settings?.padFromBookmarks },
            }).catch(() => {})
          }
        />
        <EngineStatus state={state} />
        <div className="divider" />
        <GuidancePanel state={state} />
      </div>
    </aside>
  );
}
