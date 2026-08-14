import React from 'react';
import { api } from '../api.js';
import Art from './Art.jsx';
import { PlayIcon, HeartIcon, TrashIcon, CrossIcon, NoteIcon, DownloadIcon } from '../icons.jsx';

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function SongRow({ song, index, player, timestamp, onRemove, removeIcon }) {
  const isCurrent = player.current?.id === song.id;
  return (
    <div className={`song-row ${isCurrent ? 'current' : ''}`}>
      <div className="row-index">
        {isCurrent && player.isPlaying ? (
          <span className="eq">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className="num">{index != null ? index + 1 : <NoteIcon size={14} />}</span>
        )}
      </div>
      <Art song={song} size={42} />
      <div className="row-meta">
        <div className="row-name">{song.name}</div>
        <div className="row-caption">{song.caption}</div>
      </div>
      {timestamp && <div className="row-time">{timeAgo(timestamp)}</div>}
      <div className="row-actions">
        <button
          className={`icon-btn heart ${song.bookmarked ? 'active' : ''}`}
          title={song.bookmarked ? 'Remove bookmark' : 'Bookmark'}
          onClick={() => api(`/api/songs/${song.id}/bookmark`, { method: 'POST' }).catch(() => {})}
        >
          <HeartIcon filled={song.bookmarked} size={16} />
        </button>
        <button className="icon-btn" title="Play now" onClick={() => player.play(song)}>
          <PlayIcon size={16} />
        </button>
        <a
          className="icon-btn"
          href={`/audio/${encodeURIComponent(song.file)}`}
          download
          title="Download mp3"
        >
          <DownloadIcon size={15} />
        </a>
        {onRemove && (
          <button className="icon-btn" title="Remove" onClick={() => onRemove(song)}>
            {removeIcon === 'trash' ? <TrashIcon size={15} /> : <CrossIcon size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
