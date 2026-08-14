import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { RefreshIcon } from '../icons.jsx';

// Editor for the NEXT song — the one that will be sent to ComfyUI after the
// current render finishes. Auto-saves while you type; locks once dispatched.
export default function DraftEditor({ state }) {
  const draft = state.draft;
  const [buf, setBuf] = useState(null);
  const [saveState, setSaveState] = useState('saved'); // saved | saving | conflict
  const [regenerating, setRegenerating] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!draft) {
      setBuf(null);
      return;
    }
    setBuf((prev) =>
      prev && prev.id === draft.id
        ? prev
        : { id: draft.id, name: draft.name, caption: draft.caption, lyrics: draft.lyrics },
    );
    setSaveState('saved');
  }, [draft?.id]);

  const update = (key, value) => {
    const next = { ...buf, [key]: value };
    setBuf(next);
    setSaveState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await api('/api/draft', { method: 'PATCH', body: next });
        setSaveState('saved');
      } catch {
        setSaveState('conflict');
      }
    }, 500);
  };

  const regenerate = async () => {
    setRegenerating(true);
    try {
      await api('/api/draft/regenerate', { method: 'POST' });
    } catch (err) {
      alert(err.message);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <section className="card draft-card">
      <div className="card-head">
        <div>
          <h2>Up next</h2>
          <div className="card-sub">
            The song below will be generated after the current one — edit it freely until then.
          </div>
        </div>
        <div className="card-head-actions">
          {buf && (
            <span className={`save-state ${saveState}`}>
              {saveState === 'saved' && 'Saved'}
              {saveState === 'saving' && 'Saving…'}
              {saveState === 'conflict' && 'Already dispatched'}
            </span>
          )}
          <button
            className="pill-btn"
            onClick={regenerate}
            disabled={regenerating}
            title="Ask Qwen for a different song"
          >
            <RefreshIcon size={14} />
            {regenerating ? 'Rewriting…' : 'Rewrite'}
          </button>
        </div>
      </div>

      {!buf ? (
        <div className="draft-empty">
          {state.loopEnabled
            ? 'Waiting for Qwen to write the next song…'
            : 'Enable the generation loop and the next song will appear here.'}
        </div>
      ) : (
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
    </section>
  );
}
