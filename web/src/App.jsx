import React, { useEffect, useState } from 'react';
import { subscribeState } from './api.js';
import { usePlayer } from './player.js';
import Sidebar from './components/Sidebar.jsx';
import Main from './components/Main.jsx';
import PlayerBar from './components/PlayerBar.jsx';

export default function App() {
  const [state, setState] = useState(null);
  const [view, setView] = useState('home');
  useEffect(() => subscribeState(setState), []);
  const player = usePlayer(state);

  if (!state) {
    return (
      <div className="boot">
        <div className="boot-logo">Muse</div>
        <div>Connecting to the Muse server…</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar state={state} view={view} setView={setView} />
      <Main state={state} view={view} player={player} />
      <PlayerBar player={player} />
    </div>
  );
}
