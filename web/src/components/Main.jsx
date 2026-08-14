import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Art from './Art.jsx';
import SongRow from './SongRow.jsx';
import DraftEditor from './DraftEditor.jsx';

function Lyrics({ song }) {
  if (!song) return null;
  return (
    <div className="lyrics">
      {song.lyrics.split('\n').map((line, i) => {
        const isTag = /^\s*\[.*\]\s*$/.test(line);
        return (
          <div key={i} className={isTag ? 'lyric-tag' : line.trim() ? 'lyric-line' : 'lyric-gap'}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

function NowPlayingCard({ player }) {
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
      <div>
        <div className="card-sub">In the studio · {mm}:{ss}</div>
        <div className="gen-name">{gen.name}</div>
        <div className="row-caption">{gen.caption}</div>
      </div>
    </section>
  );
}

function QueueCard({ player }) {
  const remove = (song) =>
    api(`/api/queue/${song.id}/remove`, { method: 'POST' }).catch(() => {});
  return (
    <section className="card">
      <div className="card-head">
        <h2>Queue</h2>
        <div className="card-sub">{player.queue.length} waiting</div>
      </div>
      {player.queue.length === 0 ? (
        <div className="draft-empty">The queue is empty — generated songs land here.</div>
      ) : (
        player.queue.map((song, i) => (
          <SongRow key={song.id} song={song} index={i} player={player} onRemove={remove} />
        ))
      )}
    </section>
  );
}

function HistoryView({ player }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Listen history</h2>
        <div className="card-sub">{player.history.length} plays</div>
      </div>
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
          />
        ))
      )}
    </section>
  );
}

function BookmarksView({ state, player }) {
  const bookmarked = state.songs.filter((s) => s.bookmarked).reverse();
  const remove = (song) => {
    if (confirm(`Delete “${song.name}” and its audio file?`)) {
      api(`/api/songs/${song.id}`, { method: 'DELETE' }).catch(() => {});
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Bookmarks</h2>
        <div className="card-sub">{bookmarked.length} saved</div>
      </div>
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
          />
        ))
      )}
    </section>
  );
}

export default function Main({ state, view, player }) {
  return (
    <main className="main">
      {view === 'home' && (
        <div className="home-grid">
          <div className="home-col">
            <NowPlayingCard player={player} />
          </div>
          <div className="home-col">
            <GeneratingCard state={state} />
            <DraftEditor state={state} />
            <QueueCard player={player} />
          </div>
        </div>
      )}
      {view === 'history' && <HistoryView player={player} />}
      {view === 'bookmarks' && <BookmarksView state={state} player={player} />}
    </main>
  );
}
