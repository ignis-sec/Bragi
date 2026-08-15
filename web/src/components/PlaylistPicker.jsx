import React, { useState } from 'react';
import { api } from '../api.js';
import { openModal } from '../modal.js';
import { PlaylistAddIcon } from '../icons.jsx';

// "Add to playlist" dropdown. Lists existing playlists plus "New playlist…";
// creating one adds the songs to it immediately. onDone(playlist) is called
// after a successful add.
export default function PlaylistPicker({ playlists, songIds, onDone, size = 15, label }) {
  const [open, setOpen] = useState(false);

  const addTo = async (playlist) => {
    setOpen(false);
    try {
      await api(`/api/playlists/${playlist.id}/songs`, {
        method: 'POST',
        body: { add: songIds },
      });
      onDone?.(playlist);
    } catch (err) {
      alert(err.message);
    }
  };

  const createAndAdd = () => {
    setOpen(false);
    openModal({
      type: 'name',
      title: 'New playlist',
      onSubmit: async (name) => {
        const playlist = await api('/api/playlists', { method: 'POST', body: { name } });
        await addTo(playlist);
      },
    });
  };

  return (
    <span className="pp-wrap">
      <button
        className={label ? 'pill-btn' : 'icon-btn'}
        title="Add to playlist"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <PlaylistAddIcon size={size} />
        {label}
      </button>
      {open && (
        <>
          <span className="pp-backdrop" onClick={() => setOpen(false)} />
          <div className="pp-menu" onClick={(e) => e.stopPropagation()}>
            {(playlists ?? []).map((p) => (
              <button key={p.id} className="pp-item" onClick={() => addTo(p)}>
                {p.name}
                <span className="pp-count">{p.songIds.length}</span>
              </button>
            ))}
            {playlists?.length > 0 && <div className="pp-divider" />}
            <button className="pp-item new" onClick={createAndAdd}>
              + New playlist…
            </button>
          </div>
        </>
      )}
    </span>
  );
}
