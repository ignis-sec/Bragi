import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { RefreshIcon, CrossIcon, PlusIcon, HamburgerIcon } from '../icons.jsx';

// One upcoming song, editable until it's handed to ComfyUI. Keyed by draft.id
// upstream, so a rewrite (new id) remounts and resets the buffer.
function DraftItem({ draft, index, open, onToggle, drag }) {
  const [buf, setBuf] = useState({
    name: draft.name,
    caption: draft.caption,
    lyrics: draft.lyrics,
  });
  const [saveState, setSaveState] = useState('saved'); // saved | saving | conflict
  const [rewriting, setRewriting] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const update = (key, value) => {
    const next = { ...buf, [key]: value };
    setBuf(next);
    setSaveState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await api(`/api/drafts/${draft.id}`, { method: 'PATCH', body: next });
        setSaveState('saved');
      } catch {
        setSaveState('conflict');
      }
    }, 500);
  };

  const rewrite = async (e) => {
    e.stopPropagation();
    setRewriting(true);
    try {
      await api(`/api/drafts/${draft.id}/regenerate`, { method: 'POST' });
    } catch (err) {
      alert(err.message);
      setRewriting(false);
    }
    // On success the draft id changes and this component remounts.
  };

  const remove = (e) => {
    e.stopPropagation();
    api(`/api/drafts/${draft.id}`, { method: 'DELETE' }).catch(() => {});
  };

  const incomplete = !buf.caption.trim() || !buf.lyrics.trim();

  return (
    <div
      className={`draft-item ${open ? 'open' : ''} ${
        drag.overId === draft.id ? (drag.overAfter ? 'drag-over-after' : 'drag-over-before') : ''
      }`}
      draggable={grabbed}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        drag.onStart(draft.id);
      }}
      onDragEnd={() => {
        setGrabbed(false);
        drag.onEnd();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        drag.onOver(draft.id, e.clientY > rect.top + rect.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag.onDrop();
      }}
    >
      <div className="draft-head" onClick={onToggle}>
        <span
          className="drag-handle"
          title="Drag to reorder"
          onMouseDown={() => setGrabbed(true)}
          onMouseUp={() => setGrabbed(false)}
          onClick={(e) => e.stopPropagation()}
        >
          <HamburgerIcon size={14} />
        </span>
        <span className="draft-pos">{index + 1}</span>
        <div className="row-meta">
          <div className="row-name">
            {buf.name || 'Untitled'}
            {index === 0 && <span className="draft-next-tag">next up</span>}
            {draft.custom && <span className="draft-next-tag custom">custom</span>}
            {incomplete && <span className="draft-next-tag incomplete">incomplete</span>}
            {draft.concepts?.map((c) => (
              <span
                key={c.word}
                className={`concept-chip ${draft.injected ? 'injected' : ''}`}
                title={
                  (draft.injected ? 'j-lens injected' : 'prompt seed') +
                  (c.strength != null ? ` ×${c.strength}` : '')
                }
              >
                {c.word}
              </span>
            ))}
          </div>
          {!open && <div className="row-caption">{buf.caption}</div>}
        </div>
        <span className={`save-state ${saveState}`}>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'conflict' && 'Already dispatched'}
        </span>
        <button
          className="icon-btn"
          title="Ask Qwen for a different song"
          onClick={rewrite}
          disabled={rewriting}
        >
          <RefreshIcon size={14} />
        </button>
        <button className="icon-btn" title="Discard this draft" onClick={remove}>
          <CrossIcon size={13} />
        </button>
      </div>
      {open && (
        <div className="draft-fields">
          <label>
            <span>Song name</span>
            <input value={buf.name} onChange={(e) => update('name', e.target.value)} />
          </label>
          <label>
            <span>Caption (metadata for the music model)</span>
            <textarea
              rows={4}
              value={buf.caption}
              onChange={(e) => update('caption', e.target.value)}
            />
          </label>
          <label>
            <span>Lyrics</span>
            <textarea
              rows={12}
              className="lyrics-input"
              value={buf.lyrics}
              onChange={(e) => update('lyrics', e.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export default function DraftsPanel({ state }) {
  const drafts = state.drafts ?? [];
  const [openId, setOpenId] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [overAfter, setOverAfter] = useState(false);
  const pendingOpen = useRef(null);

  // Keep something sensible expanded: default to the first draft, and open a
  // just-created custom draft as soon as it arrives over SSE.
  useEffect(() => {
    if (pendingOpen.current && drafts.some((d) => d.id === pendingOpen.current)) {
      setOpenId(pendingOpen.current);
      pendingOpen.current = null;
      return;
    }
    if (openId !== 'none' && !drafts.some((d) => d.id === openId)) {
      setOpenId(drafts[0]?.id ?? null);
    }
  }, [drafts, openId]);

  const addCustom = async () => {
    try {
      const draft = await api('/api/drafts', { method: 'POST', body: {} });
      pendingOpen.current = draft.id;
    } catch (err) {
      alert(err.message);
    }
  };

  const drag = {
    overId: dragId ? overId : null,
    overAfter,
    onStart: (id) => setDragId(id),
    onEnd: () => {
      setDragId(null);
      setOverId(null);
    },
    onOver: (id, after) => {
      if (!dragId || id === dragId) return;
      setOverId(id);
      setOverAfter(after);
    },
    onDrop: () => {
      if (!dragId || !overId || dragId === overId) return;
      const order = drafts.map((d) => d.id).filter((id) => id !== dragId);
      const at = order.indexOf(overId) + (overAfter ? 1 : 0);
      order.splice(at, 0, dragId);
      api('/api/drafts/reorder', { method: 'POST', body: { ids: order } }).catch(() => {});
      setDragId(null);
      setOverId(null);
    },
  };

  return (
    <section className="card draft-card">
      <div className="card-head">
        <div>
          <h2>Up next</h2>
          <div className="card-sub">
            Songs in line for the studio, in order. Edit them freely until dispatch; drag the
            handle to reorder.
          </div>
        </div>
        <div className="card-head-actions">
          <button className="pill-btn" onClick={addCustom} title="Write a song yourself">
            <PlusIcon size={13} />
            Custom song
          </button>
        </div>
      </div>
      {drafts.length === 0 ? (
        <div className="draft-empty">
          {state.loopEnabled
            ? 'Waiting for Qwen to write the upcoming songs…'
            : 'Enable the generation loop and the upcoming songs will appear here.'}
        </div>
      ) : (
        drafts.map((draft, i) => (
          <DraftItem
            key={draft.id}
            draft={draft}
            index={i}
            open={openId === draft.id}
            onToggle={() => setOpenId(openId === draft.id ? 'none' : draft.id)}
            drag={drag}
          />
        ))
      )}
    </section>
  );
}
