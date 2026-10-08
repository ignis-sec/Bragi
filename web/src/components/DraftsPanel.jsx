import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { RefreshIcon, CrossIcon, PlusIcon, HamburgerIcon, PencilIcon } from '../icons.jsx';
import { ConceptChips, NoiseChips } from './Chips.jsx';

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
            {draft.priority && (
              <span
                className="draft-next-tag requested"
                title={`Requested via the API — renders before everything else${
                  draft.play ? ' and plays when ready' : ''
                }`}
              >
                requested{draft.play ? ' · play' : ''}
              </span>
            )}
            {draft.custom && <span className="draft-next-tag custom">custom</span>}
            {incomplete && <span className="draft-next-tag incomplete">incomplete</span>}
            {draft.hold && <span className="draft-next-tag incomplete">on hold</span>}
            <ConceptChips concepts={draft.concepts} injected={draft.injected} />
            <NoiseChips noise={draft.noise} />
          </div>
          {!open && <div className="row-caption">{buf.caption}</div>}
        </div>
        <span className={`save-state ${saveState}`}>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'conflict' && 'Already dispatched'}
        </span>
        {draft.hold && (
          <button
            className="pill-btn"
            title="Release for rendering"
            onClick={(e) => {
              e.stopPropagation();
              api(`/api/drafts/${draft.id}`, { method: 'PATCH', body: { hold: false } }).catch(
                () => {},
              );
            }}
          >
            Ready
          </button>
        )}
        <button
          className="icon-btn"
          title="Ask Bragi for a different song"
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

// A song requested via POST /api/write that Bragi hasn't written yet.
function CommissionItem({ commission }) {
  const { status, prompt, error } = commission;
  const label = { waiting: 'waiting', writing: 'writing…', failed: 'failed' }[status] ?? status;
  return (
    <div className="draft-item">
      <div className="draft-head">
        <span className="draft-pos">
          <PencilIcon size={12} />
        </span>
        <div className="row-meta">
          <div className="row-name">
            Requested song
            <span className={`draft-next-tag ${status === 'failed' ? 'failed' : 'requested'}`}>
              {label}
            </span>
            {commission.play && <span className="draft-next-tag custom">plays when ready</span>}
          </div>
          <div className="row-caption">
            {status === 'failed' ? error : prompt || 'Written with the requested guidance'}
          </div>
        </div>
        <button
          className="icon-btn"
          title={status === 'failed' ? 'Dismiss' : 'Cancel this request'}
          onClick={() =>
            api(`/api/commissions/${commission.id}`, { method: 'DELETE' }).catch(() => {})
          }
        >
          <CrossIcon size={13} />
        </button>
      </div>
    </div>
  );
}

export default function DraftsPanel({ state }) {
  const drafts = state.drafts ?? [];
  const commissions = state.commissions ?? [];
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
      {commissions.map((c) => (
        <CommissionItem key={c.id} commission={c} />
      ))}
      {drafts.length === 0 && commissions.length === 0 ? (
        <div className="draft-empty">
          {state.songwriterOn
            ? 'Waiting for Bragi to write the upcoming songs…'
            : 'Turn on the Songwriter and upcoming songs will appear here.'}
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
