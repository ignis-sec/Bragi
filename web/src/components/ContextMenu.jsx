import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { openModal } from '../modal.js';

// Right-click context menu. Views call menu.open(event, items); an item with
// `playlistPicker: ids` swaps the menu to a playlist list on click.
export function useContextMenu() {
  const [state, setState] = useState(null); // {x, y, items} | null
  const open = (e, items) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 230);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setState({ x, y, items });
  };
  return { state, open, close: () => setState(null) };
}

export function ContextMenu({ menu, playlists }) {
  const [picking, setPicking] = useState(null); // song ids while choosing a playlist
  useEffect(() => setPicking(null), [menu.state]);
  if (!menu.state) return null;
  const { x, y, items } = menu.state;

  const addTo = async (playlistId, ids) => {
    menu.close();
    try {
      await api(`/api/playlists/${playlistId}/songs`, { method: 'POST', body: { add: ids } });
    } catch (err) {
      alert(err.message);
    }
  };

  const createAndAdd = (ids) => {
    menu.close();
    openModal({
      type: 'name',
      title: 'New playlist',
      onSubmit: async (name) => {
        const p = await api('/api/playlists', { method: 'POST', body: { name } });
        await api(`/api/playlists/${p.id}/songs`, { method: 'POST', body: { add: ids } });
      },
    });
  };

  return (
    <>
      <span className="pp-backdrop" onClick={menu.close} onContextMenu={(e) => {
        e.preventDefault();
        menu.close();
      }} />
      <div className="pp-menu ctx-menu" style={{ left: x, top: y }}>
        {picking ? (
          <>
            <div className="ctx-title">Add to playlist</div>
            {(playlists ?? []).map((p) => (
              <button key={p.id} className="pp-item" onClick={() => addTo(p.id, picking)}>
                {p.name}
                <span className="pp-count">{p.songIds.length}</span>
              </button>
            ))}
            <button className="pp-item new" onClick={() => createAndAdd(picking)}>
              + New playlist…
            </button>
          </>
        ) : (
          items
            .filter(Boolean)
            .map((item, i) =>
              item === 'divider' ? (
                <div key={i} className="pp-divider" />
              ) : (
                <button
                  key={i}
                  className={`pp-item ${item.danger ? 'danger' : ''}`}
                  onClick={() => {
                    if (item.playlistPicker) {
                      setPicking(item.playlistPicker);
                    } else {
                      menu.close();
                      item.action?.();
                    }
                  }}
                >
                  <span className="ctx-icon">{item.icon}</span>
                  {item.label}
                  {item.playlistPicker && <span className="pp-count">▸</span>}
                </button>
              ),
            )
        )}
      </div>
    </>
  );
}
