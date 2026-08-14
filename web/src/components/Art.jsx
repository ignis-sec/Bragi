import React from 'react';
import { NoteIcon } from '../icons.jsx';

function hash(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Real album cover when one has been generated; deterministic gradient
// placeholder otherwise.
export default function Art({ song, size = 48, radius = 6 }) {
  if (song?.cover) {
    return (
      <img
        className="art"
        src={`/covers/${encodeURIComponent(song.cover)}`}
        alt=""
        style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover' }}
      />
    );
  }
  const h = hash(song?.id ?? song?.name ?? '?');
  const h1 = h % 360;
  const h2 = (h1 + 40 + (h % 80)) % 360;
  return (
    <div
      className="art"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(135deg, hsl(${h1} 60% 42%), hsl(${h2} 70% 24%))`,
        fontSize: size * 0.42,
      }}
    >
      <NoteIcon size={size * 0.45} />
    </div>
  );
}
