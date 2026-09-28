import { StrictMode, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { useSession } from './hooks.js';
import { AuthView, LobbyView, RoomDetail, Topbar } from './Views.jsx';
import { GameView } from './GameView.jsx';

import './style.css';

/**
 * Componente radice: decide quale vista mostrare
 */
function App() {
  const session = useSession();

  const [roomId, setRoomId] = useState(null);
  const [gameId, setGameId] = useState(null);

  const [message, setMessage] = useState(null);

  const showMessage = useCallback((text, kind = 'error') => {
    setMessage(text ? { text, kind } : null);
  }, []);

  const handleUnauthorized = useCallback(() => {
    // Token scaduto
    session.logout();
    setGameId(null);
    setRoomId(null);
    showMessage('Sessione scaduta: accedi di nuovo.', 'error');
  }, [session, showMessage]);

  const handleLogout = useCallback(async () => {
    await session.logout();
    setGameId(null);
    setRoomId(null);
    showMessage('');
  }, [session, showMessage]);

  const openRoom = useCallback((id) => {
    showMessage('');
    setRoomId(id);
  }, [showMessage]);

  const exitRoom = useCallback((text, kind = 'info') => {
    setGameId(null);
    setRoomId(null);
    showMessage(text || '', kind);
  }, [showMessage]);

  const backToRoom = useCallback(() => {
    setGameId(null);
    showMessage('');
  }, [showMessage]);

  // - fase di avvio -

  if (session.status === 'loading') {
    return (
      <>
        <Topbar />
        <main className="view">
          <section className="panel">
            <p className="hint">Verifica della sessione...</p>
          </section>
        </main>
      </>
    );
  }

  // - non autenticato -

  if (session.status === 'anonymous') {
    return (
      <>
        <Topbar />
        <Message message={message} />
        <AuthView session={session} onError={showMessage} />
      </>
    );
  }

  // - in partita -

  if (gameId !== null) {
    return (
      <GameView
        key={gameId}
        gameId={gameId}
        roomId={roomId}
        onBackToRoom={backToRoom}
        onEnterGame={setGameId}
        onExit={exitRoom}
        onUnauthorized={handleUnauthorized}
      />
    );
  }

  // - nella lobby o in una stanza -

  return (
    <>
      <Topbar user={session.user} actions={[{ label: 'Esci', onClick: handleLogout }]} />
      <Message message={message} />
      {roomId !== null ? (
        <RoomDetail
          roomId={roomId}
          user={session.user}
          onEnterGame={setGameId}
          onExit={exitRoom}
          onError={showMessage}
          onUnauthorized={handleUnauthorized}
        />
      ) : (
        <LobbyView
          onOpenRoom={openRoom}
          onError={showMessage}
          onUnauthorized={handleUnauthorized}
        />
      )}
    </>
  );
}

function Message({ message }) {
  if (!message) return null;
  return <p className={`message message--${message.kind}`}>{message.text}</p>;
}

/**
 * Punto di ingresso dell'applicazione.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
