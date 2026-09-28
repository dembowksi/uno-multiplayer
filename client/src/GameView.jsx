import { useState, useEffect, useRef, useCallback } from 'react';
import { api, useGameSync, useRoomSync, isFinalError } from './hooks.js';
import { Topbar, Modal, roomRemovalMessage } from './Views.jsx';

/**
 * Il tavolo di gioco: etichette di carte ed eventi, la vista GameView e i suoi
 * componenti (carta, mano, centro del tavolo, giocatori, registro).
 */

// - etichette e descrizioni testuali di carte ed eventi -

const COLOR_LABEL = {
  red: 'Rosso',
  yellow: 'Giallo',
  green: 'Verde',
  blue: 'Blu'
};

const COLORS = ['red', 'yellow', 'green', 'blue'];

const KIND_SYMBOL = {
  skip: '⊘',      // cerchio sbarrato
  reverse: '↺',   // freccia circolare
  draw2: '+2',
  wild: '✦',      // stella a quattro punte
  wild4: '+4'
};

function cardSymbol(card) {
  if (!card) return '';
  return card.kind === 'number'
    ? String(card.value)
    : (KIND_SYMBOL[card.kind] || '?');
}

function describeCard(card) {
  if (!card) return 'carta';
  const color = COLOR_LABEL[card.color] || card.color || '';
  switch (card.kind) {
    case 'number':  return `${color} ${card.value}`;
    case 'skip':    return `${color} salta il turno`;
    case 'reverse': return `${color} cambio giro`;
    case 'draw2':   return `${color} pesca due`;
    case 'wild':    return 'jolly cambia colore';
    case 'wild4':   return 'jolly pesca quattro';
    default:        return 'carta';
  }
}

function isWild(card) {
  return card.kind === 'wild' || card.kind === 'wild4';
}

const ABORT_REASON_LABEL = {
  room_deleted: 'il proprietario ha eliminato la stanza',
  owner_disconnected: 'il proprietario della stanza si e\' disconnesso',
  not_enough_players: 'al tavolo e\' rimasto un solo giocatore'
};

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
}

/**
 * Traduce un evento del server in una frase leggibile.
 *
 * @param {object} event             { type, payload }
 * @param {Object<string,string>} names  mappa id giocatore -> nome utente
 * @returns {string|null} null se l'evento non va mostrato
 */
function describeEvent(event, names = {}) {
  const p = event.payload || {};
  const nameOf = (id) => names[id] || 'Un giocatore';

  switch (event.type) {
    case 'GAME_STARTED':
      return `Partita iniziata. Prima carta: ${p.firstCard}.`;
    case 'CARD_PLAYED':
      return `${nameOf(p.playerId)} gioca ${p.card}` +
             (p.count > 1 ? ` (${p.count} carte)` : '') + '.';
    case 'CARDS_DRAWN':
      return `${nameOf(p.playerId)} pesca ${p.count}` +
             (p.count === 1 ? ' carta' : ' carte') +
             (p.reason === 'penalty' ? " (penalita')" : '') + '.';
    case 'TURN_PASSED':
      return `${nameOf(p.playerId)} passa.`;
    case 'PLAYER_SKIPPED': {
      const ids = p.playerIds || [];
      if (ids.length === 0) return 'Un giocatore salta il turno.';
      return `${joinNames(ids.map(nameOf))} ${ids.length === 1 ? 'salta' : 'saltano'} il turno.`;
    }
    case 'DIRECTION_REVERSED':
      return 'Cambia il senso di gioco.';
    case 'DECK_EXHAUSTED':
      return 'Mazzo esaurito: turno saltato.';
    case 'GAME_FINISHED':
      return `Partita finita: vince ${p.username} con ${p.score} punti.`;
    case 'PLAYER_REMOVED':
      if (p.reason === 'kicked') return `Il proprietario ha rimosso ${p.username} dalla partita.`;
      if (p.reason === 'disconnected') {
        return `${p.username} ha perso la connessione ed esce dalla partita: le sue carte tornano nel mazzo.`;
      }
      return `${p.username} ha abbandonato la partita.`;
    case 'GAME_ABORTED':
      return `Partita annullata: ${ABORT_REASON_LABEL[p.reason] || 'interrotta'}.`;
    case 'TURN_CHANGED':
      return null;
    default:
      return event.type;
  }
}

// - tavolo di gioco -

const MAX_EVENTI = 60;

const ANNULLATA_CON_LA_STANZA = ['room_deleted', 'owner_disconnected'];

export function GameView({ gameId, roomId, onBackToRoom, onEnterGame, onExit, onUnauthorized }) {
  const { state, error, sendMove } = useGameSync(gameId);

  const [carteInAttesa, setCarteInAttesa] = useState(null);

  const [selezione, setSelezione] = useState([]);

  const [inInvio, setInInvio] = useState(false);
  const [messaggio, setMessaggio] = useState(null);

  const [conferma, setConferma] = useState(null);
  const [azioneInCorso, setAzioneInCorso] = useState(false);

  const [eventi, setEventi] = useState([]);
  const nomiRef = useRef({});

  const idStanza = roomId || (state && state.roomId);
  const sonoHost = !!state && state.ownerId === state.you.id;
  const partitaChiusa = !!state && state.status !== 'playing';

  const { room: stanza, gone: stanzaSparita } = useRoomSync(idStanza, partitaChiusa);

  // Accumula i nuovi eventi ricevuti con lo stato.
  useEffect(() => {
    if (!state) return;

    for (const p of state.players) nomiRef.current[p.id] = p.username;

    const nuovi = (state.events || [])
      .map((e) => ({ seq: e.seq, type: e.type, text: describeEvent(e, nomiRef.current) }))
      .filter((e) => e.text !== null);

    if (nuovi.length === 0) return;

    setEventi((precedenti) => {
      const visti = new Set(precedenti.map((e) => e.seq));
      const daAggiungere = nuovi.filter((e) => !visti.has(e.seq));
      if (daAggiungere.length === 0) return precedenti;

      // Il piu' recente in cima, registro tenuto corto.
      return [...daAggiungere.reverse(), ...precedenti].slice(0, MAX_EVENTI);
    });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    setSelezione((sel) => {
      if (sel.length === 0) return sel;
      const mioTurno = state.you.isYourTurn && state.status === 'playing';
      if (!mioTurno || !state.you.playableCardIds.includes(sel[0])) return [];
      const seguito = new Set((state.you.followUpCardIds || {})[sel[0]] || []);
      const valida = [sel[0], ...sel.slice(1).filter((id) => seguito.has(id))];
      return valida.length === sel.length ? sel : valida;
    });
  }, [state]);

  useEffect(() => {
    if (!messaggio) return undefined;
    const id = setTimeout(() => setMessaggio(null), 4000);
    return () => clearTimeout(id);
  }, [messaggio]);

  // - uscite imposte dal server -

  // Errori definitivi della sincronizzazione: sessione scaduta, rimossi dalla
  // partita dal proprietario, partita inesistente
  useEffect(() => {
    if (!isFinalError(error)) return;
    if (error.status === 401) onUnauthorized();
    else onExit(error.message);
  }, [error, onExit, onUnauthorized]);

  // Partita annullata perche' la stanza e' stata eliminata
  useEffect(() => {
    if (!state || state.status !== 'aborted') return;
    if (!ANNULLATA_CON_LA_STANZA.includes(state.abortReason)) return;
    onExit(state.ownerId === state.you.id && state.abortReason === 'room_deleted'
      ? 'Hai eliminato la stanza.'
      : `Partita annullata: ${ABORT_REASON_LABEL[state.abortReason]}.`);
  }, [state, onExit]);

  // Partita chiusa: stanza eliminata, noi rimossi
  useEffect(() => {
    if (!stanzaSparita) return;
    if (stanzaSparita.status === 401) onUnauthorized();
    else onExit(stanzaSparita.message);
  }, [stanzaSparita, onExit, onUnauthorized]);

  useEffect(() => {
    if (!stanza || !state) return;
    if (!stanza.players.some((p) => p.id === state.you.id)) {
      onExit(roomRemovalMessage(stanza.you && stanza.you.removedReason));
    } else if (stanza.activeGame && stanza.activeGame.id !== gameId) {
      onEnterGame(stanza.activeGame.id);
    }
  }, [stanza, state, gameId, onExit, onEnterGame]);

  // - mosse -

  // Invia una mossa e mostra l'eventuale rifiuto del server
  const invia = useCallback(async (move) => {
    if (inInvio) return;
    setInInvio(true);
    setMessaggio(null);

    const res = await sendMove(move);
    if (!res.ok && res.error) {
      setMessaggio(
        res.error.code === 'VERSION_CONFLICT'
          ? { text: "Lo stato e' cambiato, ho aggiornato il tavolo.", kind: 'info' }
          : { text: res.error.message, kind: 'error' }
      );
    }
    setInInvio(false);
  }, [sendMove, inInvio]);

  // Gioca una sequenza di carte
  const giocaCarte = useCallback((cardIds) => {
    if (!state || cardIds.length === 0) return;
    const ultima = state.you.hand.find((c) => c.id === cardIds[cardIds.length - 1]);
    if (!ultima) return;

    setSelezione([]);
    if (isWild(ultima)) {
      setCarteInAttesa({ cardIds });
      return;
    }
    invia({ type: 'PLAY_CARD', cardIds });
  }, [state, invia]);

  // Clic su una carta della mano.
  const cliccaCarta = useCallback((card) => {
    if (!state) return;

    if (selezione.length === 0) {
      const seguito = (state.you.followUpCardIds || {})[card.id] || [];
      if (seguito.length === 0) giocaCarte([card.id]);
      else setSelezione([card.id]);
      return;
    }

    if (selezione.includes(card.id)) {
      setSelezione(card.id === selezione[0] ? [] : selezione.filter((id) => id !== card.id));
      return;
    }

    setSelezione([...selezione, card.id]);
  }, [state, selezione, giocaCarte]);

  const scegliColore = useCallback((color) => {
    const inAttesa = carteInAttesa;
    setCarteInAttesa(null);
    if (!inAttesa) return;
    invia({
      type: 'PLAY_CARD',
      cardIds: inAttesa.cardIds,
      chosenColor: color
    });
  }, [carteInAttesa, invia]);

  // - azioni sulla stanza -

  const eseguiConfermata = useCallback(async () => {
    const azione = conferma;
    if (!azione || !idStanza) return;
    setAzioneInCorso(true);
    try {
      if (azione.kind === 'delete') {
        await api.deleteRoom(idStanza);
        onExit('Hai eliminato la stanza.');
      } else if (azione.kind === 'leave') {
        await api.leaveRoom(idStanza, state.you.id);
        onExit('Hai abbandonato la partita.');
      } else if (azione.kind === 'kick') {
        await api.leaveRoom(idStanza, azione.player.id);
      }
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else setMessaggio({ text: err.message, kind: 'error' });
    } finally {
      setAzioneInCorso(false);
      setConferma(null);
    }
  }, [conferma, idStanza, state, onExit, onUnauthorized]);

  // - caricamento ed errore -

  if (!state) {
    return (
      <div className="table-page">
        <Topbar actions={[{ label: 'Torna alla lobby', onClick: () => onExit('') }]} />
        <main className="table">
          <section className="table__center">
            <p className="status status--waiting">
              {error
                ? `Impossibile caricare la partita: ${error.message}`
                : 'Caricamento del tavolo...'}
            </p>
          </section>
        </main>
      </div>
    );
  }

  // - messaggio di stato -

  const inCorso = state.status === 'playing';
  const mioTurno = state.you.isYourTurn && inCorso;
  const giocatoreCorrente = state.players.find((p) => p.id === state.currentPlayerId);

  let stato;
  if (state.status === 'finished') {
    stato = { text: 'Partita conclusa.', kind: 'info' };
  } else if (state.status === 'aborted') {
    stato = { text: `Partita annullata: ${ABORT_REASON_LABEL[state.abortReason] || 'interrotta'}.`, kind: 'info' };
  } else if (mioTurno) {
    stato = { text: testoDelTurno(state, selezione), kind: 'turn' };
  } else {
    stato = {
      text: `Turno di ${giocatoreCorrente ? giocatoreCorrente.username : '...'}`,
      kind: 'waiting'
    };
  }

  const daMostrare = messaggio || stato;

  let comandi;
  if (!inCorso) {
    comandi = [{ label: 'Torna alla stanza', onClick: onBackToRoom }];
  } else if (sonoHost) {
    comandi = [{ label: 'Elimina stanza', danger: true, onClick: () => setConferma({ kind: 'delete' }) }];
  } else {
    comandi = [{ label: 'Abbandona partita', onClick: () => setConferma({ kind: 'leave' }) }];
  }

  const testi = testiConferma(conferma);
  const risultato = testiRisultato(state);

  // Pagina del tavolo
  return (
    <div className="table-page">
      <Topbar actions={comandi} />

      <p className={`status status--${daMostrare.kind}`}>{daMostrare.text}</p>

      <main className="table">
        <aside className="table__side">
          <PlayerList
            state={state}
            disabled={inInvio || azioneInCorso}
            canRemove={sonoHost}
            onRemove={(player) => setConferma({ kind: 'kick', player })}
          />
          <EventLog entries={eventi} />
        </aside>

        <TableCenter
          state={state}
          disabled={inInvio}
          selecting={selezione.length > 0}
          onDraw={() => invia({ type: 'DRAW_CARD' })}
          onPass={() => invia({ type: 'PASS' })}
        />
      </main>

      <Hand
        state={state}
        selection={selezione}
        disabled={inInvio}
        onCardClick={cliccaCarta}
        onConfirm={() => giocaCarte(selezione)}
        onCancel={() => setSelezione([])}
      />

      {/* Scelta del colore dopo uno o piu' jolly: vale per l'ultima carta. */}
      <Modal
        open={carteInAttesa !== null}
        title="Scegli il colore"
        text={carteInAttesa && carteInAttesa.cardIds.length > 1
          ? `Vale per l'ultima delle ${carteInAttesa.cardIds.length} carte giocate.`
          : undefined}
        actions={[{ label: 'Annulla', onClick: () => setCarteInAttesa(null) }]}
      >
        <div className="color-choices">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`color-choice color-choice--${color}`}
              onClick={() => scegliColore(color)}
            >
              {COLOR_LABEL[color]}
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={conferma !== null}
        title={testi.title}
        text={testi.text}
        actions={[
          { label: 'Annulla', onClick: () => setConferma(null), disabled: azioneInCorso },
          { label: testi.confirmLabel, kind: 'danger', onClick: eseguiConfermata, disabled: azioneInCorso }
        ]}
      />

      {risultato && (
        <Modal
          title={risultato.title}
          text={risultato.text}
          actions={[{ label: 'Torna alla stanza', kind: 'primary', onClick: onBackToRoom }]}
        />
      )}
    </div>
  );
}

/**
 *  Messaggio di stato quando tocca a noi
 */
function testoDelTurno(state, selezione) {
  if (selezione.length > 0) {
    return 'Giocata multipla: aggiungi carte con lo stesso numero o simbolo, poi premi Gioca.';
  }
  if (state.you.pendingDecision) {
    return 'Hai pescato una carta giocabile: giocala oppure passa.';
  }
  if (state.pendingDraw > 0) {
    const rilancio = state.pendingDrawKind === 'wild4'
      ? `un +4 o un +2 ${(COLOR_LABEL[state.currentColor] || '').toLowerCase()}`
      : 'un +2 o un +4';
    return `Tocca a te: rilancia con ${rilancio}, oppure pesca ${state.pendingDraw} carte.`;
  }
  return 'Tocca a te.';
}

/**
 *  Titolo, testo e pulsante della finestra di conferma
 */
function testiConferma(conferma) {
  if (!conferma) return { title: '', confirmLabel: '' };
  switch (conferma.kind) {
    case 'delete':
      return {
        title: 'Eliminare la stanza?',
        text: 'La partita in corso verra\' annullata e tutti i giocatori torneranno alla lobby.',
        confirmLabel: 'Elimina stanza'
      };
    case 'leave':
      return {
        title: 'Abbandonare la partita?',
        text: 'Uscirai anche dalla stanza; le tue carte torneranno nel mazzo.',
        confirmLabel: 'Abbandona'
      };
    case 'kick':
      return {
        title: `Rimuovere ${conferma.player.username}?`,
        text: 'Uscira\' dalla partita e dalla stanza; le sue carte torneranno nel mazzo.',
        confirmLabel: 'Rimuovi'
      };
    default:
      return { title: '', confirmLabel: '' };
  }
}

/**
 * Pannello di fine partita
 */
function testiRisultato(state) {
  if (state.status !== 'finished' && state.status !== 'aborted') return null;
  // Senza stanza non c'e' dove tornare: GameView riporta gia' alla lobby.
  if (ANNULLATA_CON_LA_STANZA.includes(state.abortReason)) return null;

  if (state.status === 'aborted') {
    return {
      title: 'Partita annullata',
      text: `Motivo: ${ABORT_REASON_LABEL[state.abortReason] || 'interrotta'}.`
    };
  }

  const winner = state.players.find((p) => p.id === state.winnerId);
  return {
    title: state.winnerId === state.you.id
      ? 'Hai vinto!'
      : `Ha vinto ${winner ? winner.username : 'un altro giocatore'}`,
    text: winner ? `${winner.score} punti` : ''
  };
}

// - componenti del tavolo -

/**
 * Carta da gioco disegnata in CSS
 *
 * @param {object}   props.card       { id, color, kind, value }
 * @param {boolean}  [props.playable] evidenzia la carta come giocabile
 * @param {number}   [props.order]    posizione nella giocata multipla
 *                                    se presente la carta e' disegnata come scelta
 * @param {Function} [props.onClick]  se assente, la carta non e' cliccabile
 */
function Card({ card, playable = false, order, onClick }) {
  const selected = order !== undefined;
  const label = describeCard(card) + (selected ? `, scelta numero ${order}` : '');
  const symbol = cardSymbol(card);

  const classes = [
    'card',
    `card--${card.color}`,
    selected ? 'card--selected' : (playable ? 'card--playable' : 'card--blocked')
  ].join(' ');

  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      disabled={!onClick}
      onClick={onClick}
    >
      <span className="card__face">{symbol}</span>
      <span className="card__corner card__corner--tl">{symbol}</span>
      <span className="card__corner card__corner--br">{symbol}</span>
      {selected && <span className="card__order">{order}</span>}
    </button>
  );
}

/**
 * Mano del giocatore
 *
 * @param {object}   props.state        vista dello stato ricevuta dal server
 * @param {string[]} props.selection    id delle carte scelte, in ordine
 * @param {Function} props.onCardClick  riceve l'oggetto carta
 * @param {Function} props.onConfirm    gioca la selezione
 * @param {Function} props.onCancel     annulla la selezione
 * @param {boolean}  props.disabled     true mentre una mossa e' in volo
 */
function Hand({ state, selection, onCardClick, onConfirm, onCancel, disabled }) {
  const myTurn = state.you.isYourTurn && state.status === 'playing';
  const order = new Map(selection.map((id, i) => [id, i + 1]));

  // Carte cliccabili in questo momento
  const clickable = new Set(selection.length === 0
    ? state.you.playableCardIds || []
    : [...selection, ...((state.you.followUpCardIds || {})[selection[0]] || [])]);

  const quante = selection.length === 1 ? '1 carta' : `${selection.length} carte`;

  return (
    <footer className="hand-area">
      <div className="hand-area__header">
        <h2 className="hand-area__title">
          La tua mano (<span id="hand-count">{state.you.hand.length}</span>)
        </h2>

        {selection.length > 0 && (
          <div className="selection-bar">
            <span className="selection-bar__hint">
              Aggiungi carte con lo stesso numero o simbolo, nell&apos;ordine in cui giocarle.
            </span>
            <button type="button" className="btn btn--primary" disabled={disabled} onClick={onConfirm}>
              Gioca {quante}
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={onCancel}>
              Annulla
            </button>
          </div>
        )}
      </div>

      <div className="hand">
        {state.you.hand.map((card) => {
          const canClick = myTurn && !disabled && clickable.has(card.id);
          return (
            <Card
              key={card.id}
              card={card}
              playable={canClick}
              order={order.get(card.id)}
              onClick={canClick ? () => onCardClick(card) : undefined}
            />
          );
        })}
      </div>
    </footer>
  );
}

/**
 * Centro del tavolo: carta in cima agli scarti, colore attivo, mazzo di pesca,
 * senso di gioco e comandi
 */
function TableCenter({ state, onDraw, onPass, disabled, selecting = false }) {
  const myTurn = state.you.isYourTurn && state.status === 'playing';

  const canDraw = myTurn && !state.you.pendingDecision && !disabled && !selecting;
  const canPass = myTurn && !!state.you.pendingDecision && !disabled && !selecting;

  return (
    <section className="table__center">

      <div className="table__info">
        <span className="info">
          Colore attivo:{' '}
          <span className={`color-indicator color-indicator--${state.currentColor}`}>
            {COLOR_LABEL[state.currentColor] || '-'}
          </span>
        </span>
        <span className="info">
          Mazzo: <strong>{state.drawPileSize}</strong>
        </span>
        <span className={`direction direction--${state.direction === 1 ? 'cw' : 'ccw'}`}>
          {state.direction === 1 ? 'senso orario' : 'senso antiorario'}
        </span>
      </div>

      {state.pendingDraw > 0 && (
        <p className="pending-draw">
          Pesca accumulata: {state.pendingDraw} carte
          {' '}({state.pendingDrawKind === 'wild4' ? 'da un +4' : 'da un +2'})
        </p>
      )}

      <div className="piles">
        <div className="pile">
          <span className="pile__label">Scarti</span>
          <div className="pile__slot">
            {state.topCard && <Card card={state.topCard} playable={false} />}
          </div>
        </div>
      </div>

      <div className="table__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canDraw}
          onClick={onDraw}
        >
          {myTurn && state.pendingDraw > 0 ? `Pesca ${state.pendingDraw}` : 'Pesca'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canPass}
          onClick={onPass}
        >
          Passa
        </button>
      </div>

    </section>
  );
}

/**
 * Elenco dei giocatori con il numero di carte in mano
 */
function PlayerList({ state, onRemove, canRemove = false, disabled }) {
  return (
    <>
      <h2 className="side__title">Giocatori</h2>
      <ul className="players">
        {state.players.map((p) => {
          const classes = [
            'player',
            p.id === state.currentPlayerId ? 'player--active' : '',
            p.id === state.you.id ? 'player--me' : ''
          ].filter(Boolean).join(' ');

          const inCorso = state.status === 'playing';
          const rimovibile = canRemove && inCorso && p.id !== state.you.id;

          return (
            <li key={p.id} className={classes}>
              <span className="player__name">
                {p.username}
                {p.id === state.ownerId ? ' (host)' : ''}
              </span>
              <span className="player__cards">
                {p.handSize} {p.handSize === 1 ? 'carta' : 'carte'}
              </span>

              {p.handSize === 1 && <span className="player__uno">UNO!</span>}

              {rimovibile && (
                <button
                  type="button"
                  className="player__remove"
                  disabled={disabled}
                  onClick={() => onRemove(p)}
                >
                  Rimuovi
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Registro degli eventi, dal piu' recente
 */
function EventLog({ entries }) {
  return (
    <>
      <h2 className="side__title">Registro</h2>
      <ul className="event-log">
        {entries.map((entry) => (
          <li
            key={entry.seq}
            className={`event event--${entry.type.toLowerCase().replace(/_/g, '-')}`}
          >
            {entry.text}
          </li>
        ))}
      </ul>
    </>
  );
}
