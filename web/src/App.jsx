import React, { useEffect, useState } from 'react';
import { subscribeState } from './api.js';
import { usePlayer } from './player.js';
import Sidebar from './components/Sidebar.jsx';
import Main from './components/Main.jsx';
import PlayerBar from './components/PlayerBar.jsx';
import { useContextMenu, ContextMenu } from './components/ContextMenu.jsx';
import ModalHost from './components/Modals.jsx';

export default function App() {
  const [state, setState] = useState(null);
  const [view, setView] = useState('home');
  useEffect(() => subscribeState(setState), []);
  const player = usePlayer(state);
  const menu = useContextMenu();

  if (!state) {
    return (
      <div className="boot">
        <div className="boot-logo">Bragi</div>
        <div>Connecting to the Bragi server…</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar state={state} view={view} setView={setView} menu={menu} />
      <Main state={state} view={view} setView={setView} player={player} menu={menu} />
      <PlayerBar player={player} state={state} />
      <ContextMenu menu={menu} playlists={state.playlists} />
      <ModalHost state={state} player={player} setView={setView} />
    </div>
  );
}
