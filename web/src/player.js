import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

// Playback lives in the browser. The server only learns about it through
// POST /api/songs/:id/played, which pops the queue and records history.
export function usePlayer(state) {
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

  const current = currentId ? (songsById.get(currentId) ?? null) : null;

  const play = useCallback((song) => {
    if (!song) return;
    armedRef.current = true;
    const audio = audioRef.current;
    audio.src = `/audio/${song.file}`;
    setCurrentId(song.id);
    setPosition(0);
    setDuration(0);
    audio.play().then(
      () => setIsPlaying(true),
      () => setIsPlaying(false),
    );
  }, []);

  const markPlayed = useCallback((id) => {
    if (id) api(`/api/songs/${id}/played`, { method: 'POST' }).catch(() => {});
  }, []);

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
    if (currentId) return;
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
  }, [currentId, queue, play, state?.settings, state?.songs]);

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

  return {
    current,
    isPlaying,
    position,
    duration,
    volume,
    queue,
    history,
    songsById,
    play,
    toggle,
    skip,
    prev,
    seek,
    setVolume,
  };
}
