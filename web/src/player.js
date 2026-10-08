import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

// Two ways to play, chosen by state.player.output:
//  - "speakers": the Bragi server plays through mpv and runs the queue
//    logic; the dashboard is a remote control (useRemotePlayer).
//  - "browser": playback lives in this tab (useLocalPlayer). The server
//    only learns about it through POST /api/songs/:id/played, which pops
//    the queue and records history.
// Both expose the same interface; usePlayer adds `output` and `setOutput`.

function useLibrary(state) {
  const songsById = useMemo(
    () => new Map((state?.songs ?? []).map((s) => [s.id, s])),
    [state?.songs],
  );
  const queue = useMemo(
    () => (state?.queue ?? []).map((id) => songsById.get(id)).filter(Boolean),
    [state?.queue, songsById],
  );
  const history = useMemo(() => {
    const entries = (state?.history ?? [])
      .map((h) => {
        const song = songsById.get(h.songId);
        return song ? { ...song, playedAt: h.playedAt } : null;
      })
      .filter(Boolean);
    return entries.reverse(); // newest first
  }, [state?.history, songsById]);
  return { songsById, queue, history };
}

function useLocalPlayer(state, { songsById, queue, history }, active) {
  const audioRef = useRef(null);
  if (!audioRef.current && typeof Audio !== 'undefined') audioRef.current = new Audio();

  const [currentId, setCurrentId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const armedRef = useRef(false); // becomes true after the first user-initiated play
  const lastEndedRef = useRef(null); // last song that finished/was skipped
  const currentIdRef = useRef(null);
  currentIdRef.current = currentId;

  const current = currentId ? (songsById.get(currentId) ?? null) : null;

  // `at`/`paused` resume mid-song (handoff from the speakers).
  const play = useCallback((song, { at = 0, paused = false } = {}) => {
    if (!song) return;
    armedRef.current = true;
    const audio = audioRef.current;
    audio.src = `/audio/${song.file}`;
    if (at) audio.currentTime = at;
    setCurrentId(song.id);
    setPosition(at);
    setDuration(0);
    if (paused) {
      setIsPlaying(false);
      return;
    }
    audio.play().then(
      () => setIsPlaying(true),
      () => setIsPlaying(false),
    );
  }, []);

  const markPlayed = useCallback((id) => {
    if (id) api(`/api/songs/${id}/played`, { method: 'POST' }).catch(() => {});
  }, []);

  // Output switched to the speakers: silence this tab.
  useEffect(() => {
    if (active) return;
    audioRef.current?.pause();
    setCurrentId(null);
    setIsPlaying(false);
  }, [active]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setPosition(audio.currentTime);
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnded = () => {
      lastEndedRef.current = currentIdRef.current;
      markPlayed(currentIdRef.current);
      setCurrentId(null);
      setIsPlaying(false);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnded);
    };
  }, [markPlayed]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Auto-advance. Runs whenever nothing is playing:
  //  - queue has songs -> play the next one (after first user play, or always
  //    with the autoplay setting on)
  //  - queue empty + "pad from bookmarks" -> play a random bookmarked song
  useEffect(() => {
    if (!active || currentId) return;
    const settings = state?.settings ?? {};
    if (queue.length) {
      if (armedRef.current || settings.autoplay) play(queue[0]);
      return;
    }
    if (settings.padFromBookmarks && armedRef.current) {
      let pool = (state?.songs ?? []).filter((s) => s.bookmarked);
      if (pool.length > 1) pool = pool.filter((s) => s.id !== lastEndedRef.current);
      if (pool.length) play(pool[Math.floor(Math.random() * pool.length)]);
    }
  }, [active, currentId, queue, play, state?.settings, state?.songs]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!currentIdRef.current) {
      if (queue.length) play(queue[0]);
      return;
    }
    if (audio.paused) {
      audio.play().then(() => setIsPlaying(true), () => {});
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, [queue, play]);

  const skip = useCallback(() => {
    const id = currentIdRef.current;
    if (id) {
      lastEndedRef.current = id;
      markPlayed(id);
      setCurrentId(null);
      setIsPlaying(false);
    } else if (queue.length) {
      play(queue[0]);
    }
  }, [queue, play, markPlayed]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    // Spotify behavior: restart if >3s in, otherwise jump to the previous song.
    if (audio.currentTime > 3 || !history.length) {
      audio.currentTime = 0;
      return;
    }
    play(history[0]);
  }, [history, play]);

  const seek = useCallback((t) => {
    audioRef.current.currentTime = t;
    setPosition(t);
  }, []);

  return { current, isPlaying, position, duration, volume, play, toggle, skip, prev, seek, setVolume };
}

const send = (path, body) =>
  api(`/api/player/${path}`, { method: 'POST', body }).catch((err) =>
    console.warn(`[player] ${path}:`, err.message),
  );

// Calls fn with the trailing value of a rapidly changing input (sliders).
function useDebounced(fn, ms) {
  const timer = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(
    (...args) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(...args), ms);
    },
    [ms],
  );
}

// Remote control for the server's mpv. The position is extrapolated from the
// server's anchor on a timer; seeks and volume changes show immediately.
function useRemotePlayer(state, { songsById }, active) {
  const p = state?.player;
  const anchor = p?.position;
  const [, tick] = useState(0);
  const [seekTo, setSeekTo] = useState(null); // {t, at, anchorTs} until the server re-anchors
  const [volume, setVolumeLocal] = useState(p?.volume ?? 0.9);
  const draggingVolume = useRef(false);

  useEffect(() => {
    if (!active || p?.status !== 'playing') return;
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [active, p?.status]);

  useEffect(() => {
    if (!draggingVolume.current && p?.volume != null) setVolumeLocal(p.volume);
  }, [p?.volume]);

  const sendSeek = useDebounced((t) => send('seek', { positionS: t }), 150);
  const sendVolume = useDebounced((v) => {
    draggingVolume.current = false;
    send('volume', { volume: v });
  }, 120);
  const play = useCallback((song) => song && send('play', { songId: song.id }), []);
  const toggle = useCallback(() => send('toggle'), []);
  const skip = useCallback(() => send('next'), []);
  const prev = useCallback(() => send('previous'), []);

  const playing = p?.status === 'playing';
  const duration = p?.durationS ?? 0;
  let position = 0;
  if (seekTo && seekTo.anchorTs === anchor?.timestampMs) {
    position = seekTo.t + (playing ? (Date.now() - seekTo.at) / 1000 : 0);
  } else if (anchor) {
    position = anchor.positionS + (anchor.speed * (Date.now() - anchor.timestampMs)) / 1000;
  }
  position = Math.max(0, duration ? Math.min(position, duration) : position);

  return {
    current: p?.songId ? (songsById.get(p.songId) ?? null) : null,
    isPlaying: playing,
    position,
    duration,
    volume,
    play,
    toggle,
    skip,
    prev,
    seek: (t) => {
      setSeekTo({ t, at: Date.now(), anchorTs: anchor?.timestampMs });
      sendSeek(t);
    },
    setVolume: (v) => {
      draggingVolume.current = true;
      setVolumeLocal(v);
      sendVolume(v);
    },
  };
}

export function usePlayer(state) {
  const output = state?.player?.output ?? 'browser';
  const library = useLibrary(state);
  const local = useLocalPlayer(state, library, Boolean(state) && output === 'browser');
  const remote = useRemotePlayer(state, library, output === 'speakers');
  const active = output === 'speakers' ? remote : local;

  // Switch outputs, handing the current song over at the same spot.
  const setOutput = useCallback(
    async (next) => {
      if (next === output) return;
      const { current, position, isPlaying } = active;
      try {
        await api('/api/player', { method: 'PATCH', body: { output: next } });
        if (!current) return;
        if (next === 'browser') {
          local.play(current, { at: position, paused: !isPlaying });
        } else {
          await api('/api/player/play', { method: 'POST', body: { songId: current.id } });
          if (position > 1) {
            await api('/api/player/seek', { method: 'POST', body: { positionS: position } });
          }
          if (!isPlaying) await api('/api/player/pause', { method: 'POST' });
        }
      } catch (err) {
        alert(err.message);
      }
    },
    [output, active, local],
  );

  return { ...active, ...library, output, setOutput };
}
