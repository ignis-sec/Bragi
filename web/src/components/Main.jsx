import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Art from './Art.jsx';
import SongRow from './SongRow.jsx';
import DraftsPanel from './DraftsPanel.jsx';
import SettingsView from './SettingsView.jsx';
import PlaylistPicker from './PlaylistPicker.jsx';
import { ConceptChips, NoiseChips } from './Chips.jsx';
import {
  CrossIcon,
  ListIcon,
  TrashIcon,
  PencilIcon,
  HeartIcon,
  PlayIcon,
  PlaylistAddIcon,
  RefreshIcon,
  DownloadIcon,
} from '../icons.jsx';
import { createPlaylist, playlistMenuItems, renamePlaylist } from './Sidebar.jsx';

// Re-render a song with its exact name/caption/lyrics. hold=true parks it in
// Up next for editing first; the view jumps home so the draft is visible.
async function rerollSong(song, hold, setView) {
  try {
    await api(`/api/songs/${song.id}/reroll`, { method: 'POST', body: { hold } });
    setView('home');
  } catch (err) {
    alert(err.message);
  }
}

// Context-menu items for a song row. `ctx` tunes the remove action.
function songMenuItems(song, { player, setView, ctx, playlist }) {
  return [
    { label: 'Play now', icon: <PlayIcon size={14} />, action: () => player.play(song) },
    {
      label: song.bookmarked ? 'Remove bookmark' : 'Bookmark',
      icon: <HeartIcon filled={song.bookmarked} size={14} />,
      action: () => api(`/api/songs/${song.id}/bookmark`, { method: 'POST' }).catch(() => {}),
    },
    { label: 'Add to playlist', icon: <PlaylistAddIcon size={14} />, playlistPicker: [song.id] },
    'divider',
    {
      label: 'Re-render (same song, new take)',
      icon: <RefreshIcon size={14} />,
      action: () => rerollSong(song, false, setView),
    },
    {
      label: 'Edit & re-render…',
      icon: <PencilIcon size={14} />,
      action: () => rerollSong(song, true, setView),
    },
    song.bookmarked && {
      label: 'Reroll album cover',
      icon: <RefreshIcon size={14} />,
      action: () =>
        api(`/api/songs/${song.id}/cover/regenerate`, { method: 'POST' }).catch(() => {}),
    },
    {
      label: 'Download mp3',
      icon: <DownloadIcon size={14} />,
      action: () => {
        const a = document.createElement('a');
        a.href = `/audio/${encodeURIComponent(song.file)}`;
        a.download = '';
        a.click();
      },
    },
    'divider',
    ctx === 'queue' && {
      label: 'Remove from queue',
      icon: <CrossIcon size={13} />,
      action: () => api(`/api/queue/${song.id}/remove`, { method: 'POST' }).catch(() => {}),
    },
    ctx === 'playlist' &&
      playlist && {
        label: 'Remove from playlist',
        icon: <CrossIcon size={13} />,
        action: () =>
          api(`/api/playlists/${playlist.id}/songs`, {
            method: 'POST',
            body: { remove: [song.id] },
          }).catch(() => {}),
      },
    {
      label: 'Delete song',
      icon: <TrashIcon size={14} />,
      danger: true,
      action: () => {
        if (confirm(`Delete “${song.name}” and its audio file?`)) {
          api(`/api/songs/${song.id}`, { method: 'DELETE' }).catch(() => {});
        }
      },
    },
  ];
}

function Lyrics({ song }) {
  if (!song) return null;
  return (
    <div className="lyrics">
      {song.lyrics.split('\n').map((line, i) => {
        const isTag = /^\s*\[.*\]\s*$/.test(line);
        return (
          <div key={i} className={isTag ? 'lyric-tag' : line.trim() ? 'lyric-line' : 'lyric-gap'}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

function NowPlayingCard({ player, state }) {
  const song = player.current;
  return (
    <section className="card now-playing">
      {song ? (
        <>
          <div className="np-head">
            <Art song={song} size={140} radius={10} />
            <div className="np-meta">
              <div className="np-label">Now playing</div>
              <h1>{song.name}</h1>
              <div className="np-caption">{song.caption}</div>
              <div className="np-actions">
                <PlaylistPicker
                  playlists={state.playlists}
                  songIds={[song.id]}
                  label="Add to playlist"
                  size={14}
                />
              </div>
            </div>
          </div>
          <Lyrics song={song} />
        </>
      ) : (
        <div className="np-empty">
          <h1>Nothing playing</h1>
          <p>Enable the generation loop, then press play once a song lands in the queue.</p>
        </div>
      )}
    </section>
  );
}

function GeneratingCard({ state }) {
  const gen = state.generating;
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!gen) return null;
  const elapsed = Math.floor((Date.now() - gen.startedAt) / 1000);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <section className="card generating-card">
      <span className="eq big">
        <i />
        <i />
        <i />
        <i />
      </span>
      <div className="gen-meta">
        <div className="card-sub">In the studio · {mm}:{ss}</div>
        <div className="gen-name">
          {gen.name}
          <ConceptChips concepts={gen.concepts} injected={gen.injected} />
          <NoiseChips noise={gen.noise} />
        </div>
        <div className="row-caption">{gen.caption}</div>
      </div>
      <button
        className="pill-btn danger"
        title="Stop this render and discard the song"
        onClick={() => api('/api/generating/cancel', { method: 'POST' }).catch(() => {})}
      >
        <CrossIcon size={12} />
        Cancel
      </button>
    </section>
  );
}

// Multi-select state, cleared on view change.
function useSelection(view) {
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => setSelected(new Set()), [view]);
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { selected, toggle, clear: () => setSelected(new Set()) };
}

// Bulk-action bar shown while a selection exists. `remove` is contextual
// ({label, handler}) — remove from queue / unfavorite / remove from playlist.
function SelectionBar({ selection, state, remove, favorite = true }) {
  const ids = [...selection.selected];
  if (!ids.length) return null;
  const bulkBookmark = (bookmarked) =>
    api('/api/songs/bulk-bookmark', { method: 'POST', body: { ids, bookmarked } })
      .then(selection.clear)
      .catch(() => {});
  return (
    <div className="selection-bar">
      <span className="sel-count">{ids.length} selected</span>
      <PlaylistPicker
        playlists={state.playlists}
        songIds={ids}
        label="Add to playlist"
        size={13}
        onDone={selection.clear}
      />
      {favorite && (
        <button className="pill-btn" onClick={() => bulkBookmark(true)}>
          <HeartIcon filled size={12} />
          Favorite
        </button>
      )}
      {remove && (
        <button
          className="pill-btn danger"
          onClick={async () => {
            await remove.handler(ids);
            selection.clear();
          }}
        >
          {remove.label}
        </button>
      )}
      <button className="pill-btn" onClick={selection.clear}>
        Clear selection
      </button>
    </div>
  );
}

// Shared row wiring: context menu + selection-aware drag payload.
function rowExtras(song, { menu, player, setView, ctx, playlist, selection }) {
  return {
    onContext: menu
      ? (e, s) => menu.open(e, songMenuItems(s, { player, setView, ctx, playlist }))
      : undefined,
    dragIds: selection?.selected.has(song.id) ? [...selection.selected] : undefined,
  };
}

function QueueCard({ player, state, selection, menu, setView }) {
  const remove = (song) =>
    api(`/api/queue/${song.id}/remove`, { method: 'POST' }).catch(() => {});
  const clearQueue = () => {
    if (confirm('Clear the whole queue? The songs stay in your library.')) {
      api('/api/queue/clear', { method: 'POST' }).catch(() => {});
    }
  };
  const bulkRemove = async (ids) => {
    for (const id of ids) await api(`/api/queue/${id}/remove`, { method: 'POST' }).catch(() => {});
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Queue</h2>
        <div className="card-head-actions">
          <div className="card-sub">{player.queue.length} waiting</div>
          {player.queue.length > 0 && (
            <button className="pill-btn" onClick={clearQueue} title="Empty the queue">
              <TrashIcon size={12} />
              Clear queue
            </button>
          )}
        </div>
      </div>
      <SelectionBar
        selection={selection}
        state={state}
        remove={{ label: 'Remove from queue', handler: bulkRemove }}
      />
      {player.queue.length === 0 ? (
        <div className="draft-empty">The queue is empty — generated songs land here.</div>
      ) : (
        player.queue.map((song, i) => (
          <SongRow
            key={song.id}
            song={song}
            index={i}
            player={player}
            onRemove={remove}
            playlists={state.playlists}
            selected={selection.selected.has(song.id)}
            onToggleSelect={selection.toggle}
            {...rowExtras(song, { menu, player, setView, ctx: 'queue', selection })}
          />
        ))
      )}
    </section>
  );
}

function HistoryView({ player, state, selection, menu, setView }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Listen history</h2>
        <div className="card-sub">{player.history.length} plays</div>
      </div>
      <SelectionBar selection={selection} state={state} />
      {player.history.length === 0 ? (
        <div className="draft-empty">Songs you finish or skip will show up here.</div>
      ) : (
        player.history.map((song, i) => (
          <SongRow
            key={`${song.id}-${song.playedAt}-${i}`}
            song={song}
            index={i}
            player={player}
            timestamp={song.playedAt}
            playlists={state.playlists}
            selected={selection.selected.has(song.id)}
            onToggleSelect={selection.toggle}
            {...rowExtras(song, { menu, player, setView, ctx: 'history', selection })}
          />
        ))
      )}
    </section>
  );
}

function BookmarksView({ state, player, selection, menu, setView }) {
  const bookmarked = state.songs.filter((s) => s.bookmarked).reverse();
  const remove = (song) => {
    if (confirm(`Delete “${song.name}” and its audio file?`)) {
      api(`/api/songs/${song.id}`, { method: 'DELETE' }).catch(() => {});
    }
  };
  const regenCover = (song) => {
    if (confirm(`Reroll the album cover for “${song.name}”? The current art is discarded.`)) {
      api(`/api/songs/${song.id}/cover/regenerate`, { method: 'POST' }).catch(() => {});
    }
  };
  const bulkUnfavorite = (ids) =>
    api('/api/songs/bulk-bookmark', { method: 'POST', body: { ids, bookmarked: false } }).catch(
      () => {},
    );
  return (
    <section className="card">
      <div className="card-head">
        <h2>Bookmarks</h2>
        <div className="card-sub">{bookmarked.length} saved</div>
      </div>
      <SelectionBar
        selection={selection}
        state={state}
        favorite={false}
        remove={{ label: 'Unfavorite', handler: bulkUnfavorite }}
      />
      {bookmarked.length === 0 ? (
        <div className="draft-empty">
          Tap the heart on a song you like — bookmarks survive the disposable churn.
        </div>
      ) : (
        bookmarked.map((song, i) => (
          <SongRow
            key={song.id}
            song={song}
            index={i}
            player={player}
            onRemove={remove}
            removeIcon="trash"
            onRegenCover={regenCover}
            playlists={state.playlists}
            selected={selection.selected.has(song.id)}
            onToggleSelect={selection.toggle}
            {...rowExtras(song, { menu, player, setView, ctx: 'bookmarks', selection })}
          />
        ))
      )}
    </section>
  );
}

function PlaylistsView({ state, setView, menu }) {
  const rename = renamePlaylist;
  const remove = (p) => {
    if (confirm(`Delete playlist “${p.name}”? The songs themselves are kept.`)) {
      api(`/api/playlists/${p.id}`, { method: 'DELETE' }).catch(() => {});
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Playlists</h2>
        <button className="pill-btn" onClick={() => createPlaylist(setView)}>
          + New playlist
        </button>
      </div>
      {state.playlists.length === 0 ? (
        <div className="draft-empty">
          No playlists yet. Create one, then add songs from the queue, bookmarks, or the player
          bar.
        </div>
      ) : (
        state.playlists.map((p) => (
          <div
            key={p.id}
            className="song-row playlist-row"
            onClick={() => setView(`playlist:${p.id}`)}
            onContextMenu={menu ? (e) => menu.open(e, playlistMenuItems(p, setView)) : undefined}
          >
            <div className="playlist-art">
              <ListIcon size={20} />
            </div>
            <div className="row-meta">
              <div className="row-name">{p.name}</div>
              <div className="row-caption">
                {p.songIds.length} song{p.songIds.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="row-actions">
              <button
                className="icon-btn"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  rename(p);
                }}
              >
                <PencilIcon size={14} />
              </button>
              <button
                className="icon-btn"
                title="Delete playlist"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(p);
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function PlaylistView({ state, player, playlistId, selection, menu, setView }) {
  const playlist = state.playlists.find((p) => p.id === playlistId);
  if (!playlist) {
    return <div className="draft-empty">This playlist no longer exists.</div>;
  }
  const songs = playlist.songIds
    .map((id) => state.songs.find((s) => s.id === id))
    .filter(Boolean);
  const removeOne = (song) =>
    api(`/api/playlists/${playlist.id}/songs`, {
      method: 'POST',
      body: { remove: [song.id] },
    }).catch(() => {});
  const bulkRemove = (ids) =>
    api(`/api/playlists/${playlist.id}/songs`, { method: 'POST', body: { remove: ids } }).catch(
      () => {},
    );
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{playlist.name}</h2>
          <div className="card-sub">
            {songs.length} song{songs.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <SelectionBar
        selection={selection}
        state={state}
        remove={{ label: 'Remove from playlist', handler: bulkRemove }}
      />
      {songs.length === 0 ? (
        <div className="draft-empty">
          Empty playlist — add songs from the queue, bookmarks, or the player bar.
        </div>
      ) : (
        songs.map((song, i) => (
          <SongRow
            key={song.id}
            song={song}
            index={i}
            player={player}
            onRemove={removeOne}
            playlists={state.playlists}
            selected={selection.selected.has(song.id)}
            onToggleSelect={selection.toggle}
            {...rowExtras(song, { menu, player, setView, ctx: 'playlist', playlist, selection })}
          />
        ))
      )}
    </section>
  );
}

export default function Main({ state, view, setView, player, menu }) {
  const selection = useSelection(view);
  const common = { state, player, selection, menu, setView };
  return (
    <main className="main">
      {view === 'home' && (
        <div className="home-grid">
          <div className="home-col">
            <NowPlayingCard player={player} state={state} />
          </div>
          <div className="home-col">
            <GeneratingCard state={state} />
            <DraftsPanel state={state} />
            <QueueCard {...common} />
          </div>
        </div>
      )}
      {view === 'history' && <HistoryView {...common} />}
      {view === 'bookmarks' && <BookmarksView {...common} />}
      {view === 'playlists' && <PlaylistsView state={state} setView={setView} menu={menu} />}
      {view.startsWith('playlist:') && (
        <PlaylistView {...common} playlistId={view.slice('playlist:'.length)} />
      )}
      {view === 'settings' && <SettingsView />}
    </main>
  );
}
