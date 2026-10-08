import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  HomeIcon,
  ClockIcon,
  HeartIcon,
  NoteIcon,
  GearIcon,
  ListIcon,
  ChevronIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
} from '../icons.jsx';
import { openModal } from '../modal.js';

// Collapsible sidebar category; collapsed state survives reloads.
function Section({ id, title, extra, children }) {
  const [open, setOpen] = useState(() => localStorage.getItem(`sec-${id}`) !== '0');
  const toggle = () => {
    localStorage.setItem(`sec-${id}`, open ? '0' : '1');
    setOpen(!open);
  };
  return (
    <div className="side-section">
      <div className="section-head" onClick={toggle}>
        <ChevronIcon open={open} size={13} />
        <span className="panel-title">{title}</span>
        {extra && <span onClick={(e) => e.stopPropagation()}>{extra}</span>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

const PHASE_LABELS = {
  idle: 'Idle',
  'queue-full': 'Queue full — waiting for you to listen',
  'waiting-drafts': 'Composer waiting — no renderable drafts',
  'lookahead-full': 'Up next is full — songwriter resting',
  'unloading-comfy': 'Unloading ComfyUI models…',
  'starting-llm': 'Starting the songwriter…',
  'writing-draft': 'Bragi is writing the next song…',
  'unloading-llm': 'Stopping the songwriter…',
  'rendering-audio': 'ComfyUI is rendering audio…',
  covers: 'Making album covers…',
  'waiting-gpu': 'Waiting for the GPU…',
  preempted: 'Paused — another workload needed the GPU',
  error: 'Error — retrying shortly',
};

function EngineStatus({ state }) {
  const { engine, songwriterOn, composerOn, lastError, generating } = state;
  // The engine also runs with both toggles off for songs requested over the API.
  const anyOn = songwriterOn || composerOn || (engine?.phase && engine.phase !== 'idle');
  let label = anyOn ? (PHASE_LABELS[engine?.phase] ?? engine?.phase) : 'Songwriter & composer off';
  if (engine?.phase === 'rendering-audio' && generating?.name) {
    label = `Rendering “${generating.name}”…`;
  } else if (engine?.phase === 'waiting-gpu' && engine.detail) {
    label = `${engine.detail}…`;
  }
  const busy =
    anyOn && !['idle', 'queue-full', 'lookahead-full', 'waiting-drafts', 'error'].includes(engine?.phase);
  const loopEnabled = anyOn;
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
        {session?.noise && (
          <div className="status-concepts">
            Noise ×{session.noise.strength}:{' '}
            {session.noise.words
              .filter((w, i) => (session.noise.weights?.[i] ?? 1) >= 0)
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
      <div className="g-hint">Applies to the next songs Bragi writes.</div>
    </div>
  );
}

function ToggleRow({ title, hint, on, onToggle }) {
  return (
    <div className="loop-row">
      <div>
        <div className="toggle-title">{title}</div>
        <div className="g-hint">{hint}</div>
      </div>
      <button className={`switch ${on ? 'on' : ''}`} aria-label={`Toggle ${title}`} onClick={onToggle}>
        <span className="knob" />
      </button>
    </div>
  );
}

export function renamePlaylist(p) {
  openModal({
    type: 'name',
    title: 'Rename playlist',
    initial: p.name,
    submitLabel: 'Rename',
    onSubmit: (name) => api(`/api/playlists/${p.id}`, { method: 'PATCH', body: { name } }),
  });
}

export function playlistMenuItems(p, setView) {
  return [
    { label: 'Open', icon: <ListIcon size={14} />, action: () => setView(`playlist:${p.id}`) },
    { label: 'Rename…', icon: <PencilIcon size={14} />, action: () => renamePlaylist(p) },
    'divider',
    {
      label: 'Delete playlist',
      icon: <TrashIcon size={14} />,
      danger: true,
      action: () => {
        if (confirm(`Delete playlist “${p.name}”? The songs themselves are kept.`)) {
          api(`/api/playlists/${p.id}`, { method: 'DELETE' }).catch(() => {});
        }
      },
    },
  ];
}

export function createPlaylist(setView) {
  openModal({
    type: 'name',
    title: 'New playlist',
    onSubmit: async (name) => {
      const p = await api('/api/playlists', { method: 'POST', body: { name } });
      setView?.(`playlist:${p.id}`);
    },
  });
}

// Sidebar playlist list: click to open, drag rows to reorder, drop songs on a
// row to add them, right-click for actions.
function PlaylistList({ state, view, setView, onContext }) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [songOverId, setSongOverId] = useState(null);

  const reorderTo = (targetId) => {
    if (!dragId || dragId === targetId) return;
    const order = state.playlists.map((p) => p.id).filter((id) => id !== dragId);
    order.splice(order.indexOf(targetId), 0, dragId);
    api('/api/playlists/reorder', { method: 'POST', body: { ids: order } }).catch(() => {});
  };

  return (
    <>
      {state.playlists.length === 0 && (
        <div className="g-hint">No playlists yet — make one with +</div>
      )}
      {state.playlists.map((p) => (
        <button
          key={p.id}
          className={`playlist-item ${view === `playlist:${p.id}` ? 'active' : ''} ${
            overId === p.id ? 'drag-over' : ''
          } ${songOverId === p.id ? 'song-over' : ''}`}
          onClick={() => setView(`playlist:${p.id}`)}
          onContextMenu={onContext ? (e) => onContext(e, p) : undefined}
          draggable
          onDragStart={(e) => {
            setDragId(p.id);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-bragi-playlist', p.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (e.dataTransfer.types.includes('application/x-bragi-songs')) {
              setSongOverId(p.id);
            } else if (dragId && dragId !== p.id) {
              setOverId(p.id);
            }
          }}
          onDragLeave={() => {
            setSongOverId((id) => (id === p.id ? null : id));
            setOverId((id) => (id === p.id ? null : id));
          }}
          onDrop={(e) => {
            e.preventDefault();
            setSongOverId(null);
            setOverId(null);
            const songs = e.dataTransfer.getData('application/x-bragi-songs');
            if (songs) {
              try {
                const ids = JSON.parse(songs);
                api(`/api/playlists/${p.id}/songs`, {
                  method: 'POST',
                  body: { add: ids },
                }).catch(() => {});
              } catch {
                /* bad payload */
              }
            } else {
              reorderTo(p.id);
            }
          }}
        >
          <ListIcon size={14} />
          <span className="playlist-name">{p.name}</span>
          <span className="pp-count">{p.songIds.length}</span>
        </button>
      ))}
    </>
  );
}

export default function Sidebar({ state, view, setView, menu }) {
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
          <span>Bragi</span>
        </div>
        <nav>
          {navItem('home', <HomeIcon size={20} />, 'Home')}
          {navItem('history', <ClockIcon size={20} />, 'History')}
          {navItem('bookmarks', <HeartIcon size={20} />, 'Bookmarks')}
          {navItem('playlists', <ListIcon size={20} />, 'Playlists')}
          {navItem('settings', <GearIcon size={20} />, 'Settings')}
        </nav>
      </div>

      <div className="side-card grow">
        <EngineStatus state={state} />
        <div className="divider" />
        <Section id="controls" title="Controls">
          <ToggleRow
            title="Songwriter"
            hint="Writes new songs until Up next is full"
            on={state.songwriterOn}
            onToggle={() =>
              api('/api/engine', {
                method: 'POST',
                body: { songwriter: !state.songwriterOn },
              }).catch(() => {})
            }
          />
          <ToggleRow
            title="Composer"
            hint="Renders songs from Up next into audio"
            on={state.composerOn}
            onToggle={() =>
              api('/api/engine', {
                method: 'POST',
                body: { composer: !state.composerOn },
              }).catch(() => {})
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
          <ToggleRow
            title="Album art"
            hint="Generate covers for bookmarks while idle"
            on={state.settings?.albumArt}
            onToggle={() =>
              api('/api/settings', {
                method: 'PATCH',
                body: { albumArt: !state.settings?.albumArt },
              }).catch(() => {})
            }
          />
          <ToggleRow
            title="Semantic noise"
            hint="Blend random word directions into each session (j-lens)"
            on={state.settings?.semanticNoise}
            onToggle={() =>
              api('/api/settings', {
                method: 'PATCH',
                body: { semanticNoise: !state.settings?.semanticNoise },
              }).catch(() => {})
            }
          />
        </Section>
        <div className="divider" />
        <Section id="guide" title="Guide the generation">
          <GuidancePanel state={state} />
        </Section>
        <div className="divider" />
        <Section
          id="playlists"
          title="Playlists"
          extra={
            <button className="icon-btn tiny" title="New playlist" onClick={() => createPlaylist(setView)}>
              <PlusIcon size={13} />
            </button>
          }
        >
          <PlaylistList
            state={state}
            view={view}
            setView={setView}
            onContext={menu ? (e, p) => menu.open(e, playlistMenuItems(p, setView)) : undefined}
          />
        </Section>
      </div>
    </aside>
  );
}
