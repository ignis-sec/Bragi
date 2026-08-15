import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { setModalListener } from '../modal.js';
import Art from './Art.jsx';
import PlaylistPicker from './PlaylistPicker.jsx';
import { ConceptChips, NoiseChips } from './Chips.jsx';
import {
  PlayIcon,
  HeartIcon,
  DownloadIcon,
  RefreshIcon,
  PencilIcon,
  CrossIcon,
} from '../icons.jsx';

// modal shapes:
//   { type: 'name', title, initial?, submitLabel?, onSubmit(name) }
//   { type: 'song', songId }
export default function ModalHost({ state, player, setView }) {
  const [modal, setModal] = useState(null);
  useEffect(() => setModalListener(setModal), []);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && setModal(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!modal) return null;
  const close = () => setModal(null);
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={close} title="Close">
          <CrossIcon size={14} />
        </button>
        {modal.type === 'name' && <NameModal modal={modal} close={close} />}
        {modal.type === 'song' && (
          <SongModal songId={modal.songId} state={state} player={player} setView={setView} close={close} />
        )}
      </div>
    </div>
  );
}

function NameModal({ modal, close }) {
  const [name, setName] = useState(modal.initial ?? '');
  const inputRef = useRef(null);
  useEffect(() => inputRef.current?.select(), []);
  const submit = async () => {
    if (!name.trim()) return;
    close();
    try {
      await modal.onSubmit(name.trim());
    } catch (err) {
      alert(err.message);
    }
  };
  return (
    <>
      <h2 className="modal-title">{modal.title}</h2>
      <input
        ref={inputRef}
        value={name}
        placeholder="Name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        autoFocus
      />
      <div className="modal-actions">
        <button className="pill-btn" onClick={close}>
          Cancel
        </button>
        <button className="pill-btn accent" onClick={submit} disabled={!name.trim()}>
          {modal.submitLabel ?? 'Create'}
        </button>
      </div>
    </>
  );
}

function SongModal({ songId, state, player, setView, close }) {
  // Read from live state so bookmark/cover changes reflect immediately.
  const song = state.songs.find((s) => s.id === songId);
  if (!song) return <div className="draft-empty">This song no longer exists.</div>;

  const reroll = async (hold) => {
    close();
    try {
      await api(`/api/songs/${song.id}/reroll`, { method: 'POST', body: { hold } });
      setView('home');
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <>
      <div className="modal-song-head">
        <Art song={song} size={120} radius={10} />
        <div className="np-meta">
          <h2 className="modal-title">
            {song.name}
            <ConceptChips concepts={song.concepts} injected={song.injected} />
            <NoiseChips noise={song.noise} />
          </h2>
          <div className="np-caption">{song.caption}</div>
        </div>
      </div>
      <div className="modal-actions wrap">
        <button className="pill-btn accent" onClick={() => player.play(song)}>
          <PlayIcon size={13} />
          Play
        </button>
        <button
          className={`pill-btn ${song.bookmarked ? 'active-heart' : ''}`}
          onClick={() => api(`/api/songs/${song.id}/bookmark`, { method: 'POST' }).catch(() => {})}
        >
          <HeartIcon filled={song.bookmarked} size={13} />
          {song.bookmarked ? 'Bookmarked' : 'Bookmark'}
        </button>
        <PlaylistPicker playlists={state.playlists} songIds={[song.id]} label="Add to playlist" size={13} />
        <button className="pill-btn" onClick={() => reroll(false)}>
          <RefreshIcon size={13} />
          Re-render
        </button>
        <button className="pill-btn" onClick={() => reroll(true)}>
          <PencilIcon size={13} />
          Edit &amp; re-render
        </button>
        <a className="pill-btn" href={`/audio/${encodeURIComponent(song.file)}`} download>
          <DownloadIcon size={13} />
          Download
        </a>
        {song.bookmarked && (
          <button
            className="pill-btn"
            onClick={() =>
              api(`/api/songs/${song.id}/cover/regenerate`, { method: 'POST' }).catch(() => {})
            }
          >
            <RefreshIcon size={13} />
            Reroll cover
          </button>
        )}
      </div>
      <div className="lyrics modal-lyrics">
        {song.lyrics.split('\n').map((line, i) => {
          const isTag = /^\s*\[.*\]\s*$/.test(line);
          return (
            <div key={i} className={isTag ? 'lyric-tag' : line.trim() ? 'lyric-line' : 'lyric-gap'}>
              {line || ' '}
            </div>
          );
        })}
      </div>
    </>
  );
}
