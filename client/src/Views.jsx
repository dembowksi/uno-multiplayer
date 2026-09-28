import { useState, useEffect } from 'react';
import { api, useSync, useRoomSync } from './hooks.js';

/**
 * Le viste fuori dal tavolo di gioco: accesso, lobby, sala d'attesa, e i
 * componenti comuni a tutte (barra superiore e finestra).
 */

// - componenti comuni -

/**
 * Barra superiore: titolo, nome utente, comandi disponibili
 *
 * @param {object}  [props.user]  utente autenticato, se c'e'
 * @param {Array<{label: string, onClick: Function, danger?: boolean}>} [props.actions]
 */
export function Topbar({ user, actions = [] }) {
  return (
    <header className="topbar">
      <h1 className="topbar__title">UNO Online</h1>
      <div className="topbar__right">
        {user && <span>{user.username}</span>}
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={`btn ${a.danger ? 'btn--danger' : 'btn--ghost'}`}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </div>
    </header>
  );
}

/**
 * Finestra: conferme delle azioni irreversibili,
 * scelta colore dopo un jolly, pannello di fine partita.
 *
 * @param {boolean} [props.open]
 * @param {string}  props.title
 * @param {string}  [props.text]
 * @param {*}       [props.children]
 * @param {Array<{label: string, onClick: Function, kind?: string, disabled?: boolean}>} props.actions
 */
export function Modal({ open = true, title, text, children, actions }) {
  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__box">
        <h2>{title}</h2>
        {text && <p className="modal__text">{text}</p>}
        {children}
        <div className="modal__actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`btn btn--${a.kind || 'ghost'}`}
              onClick={a.onClick}
              disabled={a.disabled}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const ROOM_REMOVAL_MESSAGE = {
  kicked: 'Il proprietario ti ha rimosso dalla stanza.',
  disconnected: 'La connessione si e\' interrotta troppo a lungo: sei fuori dalla stanza.',
  left: 'Hai lasciato la stanza.'
};

export function roomRemovalMessage(reason) {
  return ROOM_REMOVAL_MESSAGE[reason] || 'Non fai piu\' parte della stanza.';
}

// - accesso e registrazione -

export function AuthView({ session, onError }) {
  const [mode, setMode] = useState('login');      // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    setBusy(true);
    onError('');
    try {
      if (mode === 'register') {
        await session.register(username.trim(), password);
      } else {
        await session.login(username.trim(), password);
      }
    } catch (err) {
      onError(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const registrazione = mode === 'register';

  return (
    <main className="view">
      <section className="panel">
        <h2>{registrazione ? 'Registrati' : 'Accedi'}</h2>

        <form className="form" onSubmit={handleSubmit}>
          <label className="form__field">
            <span>Nome utente</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              pattern={registrazione ? '[a-zA-Z0-9_.\\-]+' : undefined}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            {registrazione && (
              <small>Da 3 a 32 caratteri: lettere, cifre, punto, trattino, underscore.</small>
            )}
          </label>

          <label className="form__field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete={registrazione ? 'new-password' : 'current-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {registrazione && <small>Almeno 8 caratteri.</small>}
          </label>

          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy
              ? 'Attendere...'
              : (registrazione ? 'Crea account' : 'Accedi')}
          </button>
        </form>

        <p className="panel__footer">
          {registrazione ? 'Hai gia’ un account? ' : 'Non hai un account? '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setMode(registrazione ? 'login' : 'register');
              onError('');
            }}
          >
            {registrazione ? 'Accedi' : 'Registrati'}
          </a>
        </p>
      </section>
    </main>
  );
}

// - lobby -

const loadRooms = (since, signal) => api.listRooms(signal);

/**
 * Lobby: elenco delle stanze aperte e creazione di una nuova stanza
 *
 * @param {Function} props.onOpenRoom  riceve l'id della stanza in cui si entra
 * @param {Function} props.onError
 * @param {Function} props.onUnauthorized chiamata se il token e' scaduto
 */
export function LobbyView({ onOpenRoom, onError, onUnauthorized }) {
  const { data, apply, error } = useSync(loadRooms, { delayMs: 5000 });
  const rooms = data ? data.items : [];
  const [busy, setBusy] = useState(false);

  const [roomName, setRoomName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);

  useEffect(() => {
    if (error && error.status === 401) onUnauthorized();
  }, [error, onUnauthorized]);

  function refreshRooms() {
    api.listRooms().then(apply).catch(() => { /* ci pensera' il ciclo */ });
  }

  async function handleCreateRoom(event) {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      const room = await api.createRoom(roomName.trim(), Number(maxPlayers));
      onOpenRoom(room.id);
    } catch (err) {
      onError(err.message, 'error');
      setBusy(false);
    }
  }

  async function handleJoin(roomId) {
    setBusy(true);
    onError('');
    try {
      await api.joinRoom(roomId);
      onOpenRoom(roomId);
    } catch (err) {
      onError(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <main className="view view--lobby">

      <section className="panel panel--rooms">
        <div className="panel__header">
          <h2>Stanze aperte</h2>
          <button type="button" className="btn btn--ghost" onClick={refreshRooms}>
            Aggiorna
          </button>
        </div>

        <ul className="rooms">
          {rooms.length === 0 ? (
            <li className="rooms__empty">Nessuna stanza aperta. Creane una.</li>
          ) : (
            rooms.map((room) => (
              <li key={room.id} className="room">
                <span className="room__name">{room.name}</span>
                <span className="room__meta">
                  {room.player_count}/{room.max_players} - di {room.owner_username}
                </span>
                <button
                  type="button"
                  className="btn btn--primary room__join"
                  disabled={busy || room.player_count >= room.max_players}
                  onClick={() => handleJoin(room.id)}
                >
                  Entra
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="panel">
        <h2>Crea una stanza</h2>
        <form className="form" onSubmit={handleCreateRoom}>
          <label className="form__field">
            <span>Nome della stanza</span>
            <input
              type="text"
              required
              minLength={3}
              maxLength={64}
              placeholder="Partita della sera"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
            />
          </label>

          <label className="form__field">
            <span>Giocatori massimi</span>
            <select
              value={maxPlayers}
              onChange={(e) => setMaxPlayers(e.target.value)}
            >
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="6">6</option>
            </select>
          </label>

          <button type="submit" className="btn btn--primary" disabled={busy}>
            Crea
          </button>
        </form>
      </section>

    </main>
  );
}

// - sala d'attesa di una stanza -

export function RoomDetail({ roomId, user, onEnterGame, onExit, onError, onUnauthorized }) {
  const { room, gone } = useRoomSync(roomId);
  const [busy, setBusy] = useState(false);

  const [conferma, setConferma] = useState(null);

  // La stanza non e' piu' accessibile.
  useEffect(() => {
    if (!gone) return;
    if (gone.status === 401) onUnauthorized();
    else onExit(gone.message);
  }, [gone, onExit, onUnauthorized]);

  // Novita' sulla stanza: uscita forzata, avvio della partita.
  useEffect(() => {
    if (!room) return;
    if (!room.players.some((p) => p.id === user.id)) {
      onExit(roomRemovalMessage(room.you && room.you.removedReason));
    } else if (room.activeGame) {
      onEnterGame(room.activeGame.id);
    }
  }, [room, user.id, onEnterGame, onExit]);

  async function esegui(azione) {
    setBusy(true);
    onError('');
    try {
      await azione();
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else onError(err.message, 'error');
    } finally {
      setBusy(false);
      setConferma(null);
    }
  }

  function handleStart() {
    esegui(async () => {
      const game = await api.startGame(roomId);
      onEnterGame(game.id);
    });
  }

  function handleLeave() {
    esegui(async () => {
      try {
        await api.leaveRoom(roomId, user.id);
      } catch (err) {
        if (err.status !== 404 && err.status !== 410) throw err;
      }
      onExit('');
    });
  }

  function handleDelete() {
    esegui(async () => {
      await api.deleteRoom(roomId);
      onExit('Hai eliminato la stanza.');
    });
  }

  function handleKick(player) {
    esegui(() => api.leaveRoom(roomId, player.id));
  }

  if (!room) {
    return (
      <main className="view view--lobby">
        <section className="panel">
          <p className="hint">Caricamento della stanza...</p>
        </section>
      </main>
    );
  }

  const sonoHost = room.owner_id === user.id;
  const abbastanzaGiocatori = room.players.length >= 2;

  const daRimuovere = conferma && conferma.kind === 'kick' ? conferma.player : null;

  return (
    <main className="view view--lobby">
      <section className="panel panel--room-detail">
        <h2>{room.name}</h2>
        <p className="hint">
          {sonoHost
            ? 'Quando siete abbastanza, avvia la partita. Se chiudi la pagina o ti disconnetti, la stanza viene eliminata.'
            : "In attesa che l'host avvii la partita. Se chiudi la pagina o ti disconnetti, esci dalla stanza."}
        </p>

        <ul className="room-players">
          {room.players.map((p) => (
            <li key={p.id} className="room-player">
              <span className="room-player__name">
                {p.username}
                {p.id === room.owner_id ? ' (host)' : ''}
                {p.id === user.id ? ' (tu)' : ''}
              </span>
              {sonoHost && p.id !== room.owner_id && (
                <button
                  type="button"
                  className="room-player__remove"
                  disabled={busy}
                  onClick={() => setConferma({ kind: 'kick', player: p })}
                >
                  Rimuovi
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="panel__actions">
          {sonoHost ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !abbastanzaGiocatori}
                onClick={handleStart}
              >
                Avvia partita
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={() => setConferma({ kind: 'delete' })}
              >
                Elimina stanza
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={handleLeave}>
              Esci dalla stanza
            </button>
          )}
        </div>
      </section>

      <Modal
        open={conferma !== null}
        title={daRimuovere ? `Rimuovere ${daRimuovere.username}?` : 'Eliminare la stanza?'}
        text={daRimuovere ? "Il giocatore tornera' alla lobby." : 'Tutti i giocatori torneranno alla lobby.'}
        actions={[
          { label: 'Annulla', onClick: () => setConferma(null), disabled: busy },
          {
            label: daRimuovere ? 'Rimuovi' : 'Elimina stanza',
            kind: 'danger',
            disabled: busy,
            onClick: () => (daRimuovere ? handleKick(daRimuovere) : handleDelete())
          }
        ]}
      />
    </main>
  );
}
