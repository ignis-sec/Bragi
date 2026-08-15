import React from 'react';
import { api } from '../api.js';
import Art from './Art.jsx';
import PlaylistPicker from './PlaylistPicker.jsx';
import { openModal } from '../modal.js';
import { PlayIcon, PauseIcon, NextIcon, PrevIcon, HeartIcon, DownloadIcon } from '../icons.jsx';

function fmt(t) {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

export default function PlayerBar({ player, state }) {
  const { current, isPlaying, position, duration } = player;
  return (
    <footer className="player-bar">
      <div className="pb-left">
        {current ? (
          <>
            <Art song={current} size={56} />
            <div
              className="pb-meta clickable"
              title="Song details"
              onClick={() => openModal({ type: 'song', songId: current.id })}
            >
              <div className="pb-name">{current.name}</div>
              <div className="pb-caption">{current.caption}</div>
            </div>
            <button
              className={`icon-btn heart ${current.bookmarked ? 'active' : ''}`}
              title="Bookmark this song"
              onClick={() =>
                api(`/api/songs/${current.id}/bookmark`, { method: 'POST' }).catch(() => {})
              }
            >
              <HeartIcon filled={current.bookmarked} size={18} />
            </button>
            <PlaylistPicker playlists={state?.playlists} songIds={[current.id]} size={17} />
            <a
              className="icon-btn"
              href={`/audio/${encodeURIComponent(current.file)}`}
              download
              title="Download mp3"
            >
              <DownloadIcon size={17} />
            </a>
          </>
        ) : (
          <div className="pb-caption">Nothing playing</div>
        )}
      </div>

      <div className="pb-center">
        <div className="pb-buttons">
          <button className="icon-btn" onClick={player.prev} title="Previous">
            <PrevIcon size={18} />
          </button>
          <button className="play-btn" onClick={player.toggle} title="Play / pause">
            {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </button>
          <button className="icon-btn" onClick={player.skip} title="Next">
            <NextIcon size={18} />
          </button>
        </div>
        <div className="pb-seek">
          <span>{fmt(position)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.5}
            value={Math.min(position, duration || 0)}
            onChange={(e) => player.seek(Number(e.target.value))}
            style={{ '--fill': `${duration ? (position / duration) * 100 : 0}%` }}
          />
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <div className="pb-right">
        <span className="pb-caption">vol</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={player.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
          style={{ '--fill': `${player.volume * 100}%` }}
        />
      </div>
    </footer>
  );
}
