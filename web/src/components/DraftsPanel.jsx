import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { RefreshIcon, CrossIcon } from '../icons.jsx';

// One upcoming song, editable until it's handed to ComfyUI. Keyed by draft.id
// upstream, so a rewrite (new id) remounts and resets the buffer.
function DraftItem({ draft, index, open, onToggle }) {
  const [buf, setBuf] = useState({
    name: draft.name,
    caption: draft.caption,
    lyrics: draft.lyrics,
  });
  const [saveState, setSaveState] = useState('saved'); // saved | saving | conflict
  const [rewriting, setRewriting] = useState(false);
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

  return (
    <div className={`draft-item ${open ? 'open' : ''}`}>
      <div className="draft-head" onClick={onToggle}>
        <span className="draft-pos">{index + 1}</span>
        <div className="row-meta">
          <div className="row-name">
            {buf.name || 'Untitled'}
            {index === 0 && <span className="draft-next-tag">next up</span>}
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
              rows={2}
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

  // Keep something sensible expanded: default to the first draft.
  useEffect(() => {
    if (openId !== 'none' && !drafts.some((d) => d.id === openId)) {
      setOpenId(drafts[0]?.id ?? null);
    }
  }, [drafts, openId]);

  return (
    <section className="card draft-card">
      <div className="card-head">
        <div>
          <h2>Up next</h2>
          <div className="card-sub">
            Songs Qwen already wrote, in order — the first goes to the studio next. Edit them
            freely until then.
          </div>
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
          />
        ))
      )}
    </section>
  );
}
