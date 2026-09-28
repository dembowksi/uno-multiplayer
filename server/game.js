'use strict';

/**
 * Il gioco: carte e mazzo, regolamento, motore della partita
 */

// - Carte e mazzo -

/** Quattro colori giocabili */
const COLORS = ['red', 'yellow', 'green', 'blue'];

/** Colore dei jolly */
const WILD = 'wild';

const KIND = {
  NUMBER: 'number',
  SKIP: 'skip',
  REVERSE: 'reverse',
  DRAW_TWO: 'draw2',
  WILD: 'wild',
  WILD_DRAW_FOUR: 'wild4'
};

/** Punteggio delle carte non numeriche */
const POINTS = {
  [KIND.SKIP]: 20,
  [KIND.REVERSE]: 20,
  [KIND.DRAW_TWO]: 20,
  [KIND.WILD]: 50,
  [KIND.WILD_DRAW_FOUR]: 50
};

/**
 * @param {string} id          univoco nel mazzo, es. "red-7-b"
 * @param {string} color       uno di COLORS oppure WILD
 * @param {string} kind        uno dei valori di KIND
 * @param {number|null} value  cifra 0..9 per le numeriche, null altrimenti
 */
function createCard(id, color, kind, value = null) {
  return { id, color, kind, value };
}

const isWild = (card) =>
  card.kind === KIND.WILD || card.kind === KIND.WILD_DRAW_FOUR;

/** Punti della carta a fine mano */
const pointsOf = (card) =>
  card.kind === KIND.NUMBER ? card.value : (POINTS[card.kind] || 0);

/** Etichetta leggibile */
function labelOf(card) {
  switch (card.kind) {
    case KIND.NUMBER: return `${card.color} ${card.value}`;
    case KIND.SKIP: return `${card.color} skip`;
    case KIND.REVERSE: return `${card.color} reverse`;
    case KIND.DRAW_TWO: return `${card.color} +2`;
    case KIND.WILD: return 'wild';
    case KIND.WILD_DRAW_FOUR: return 'wild +4';
    default: return 'unknown';
  }
}

/** Costruisce il mazzo completo e ordinato di 108 carte. */
function buildDeck() {
  const cards = [];

  for (const color of COLORS) {
    cards.push(createCard(`${color}-0`, color, KIND.NUMBER, 0));

    for (let value = 1; value <= 9; value++) {
      cards.push(createCard(`${color}-${value}-a`, color, KIND.NUMBER, value));
      cards.push(createCard(`${color}-${value}-b`, color, KIND.NUMBER, value));
    }

    for (const copy of ['a', 'b']) {
      cards.push(createCard(`${color}-skip-${copy}`, color, KIND.SKIP));
      cards.push(createCard(`${color}-reverse-${copy}`, color, KIND.REVERSE));
      cards.push(createCard(`${color}-draw2-${copy}`, color, KIND.DRAW_TWO));
    }
  }

  for (let i = 1; i <= 4; i++) {
    cards.push(createCard(`wild-${i}`, WILD, KIND.WILD));
    cards.push(createCard(`wild4-${i}`, WILD, KIND.WILD_DRAW_FOUR));
  }
  return cards;
}

/** Mescolamento */
function shuffle(cards) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Rifornisce la pila di pesca esaurita: 
 * si rimescolano gli scarti tranne la carta in cima
 *
 * @returns {boolean} false se non c'erano carte da riciclare
 */
function replenishDrawPile(state) {
  if (state.drawPile.length > 0) return true;
  if (state.discardPile.length <= 1) return false;

  const top = state.discardPile[state.discardPile.length - 1];
  state.drawPile = shuffle(state.discardPile.slice(0, -1));
  state.discardPile = [top];
  return true;
}

/**
 * Estrae `count` carte, riciclando gli scarti se serve
 */
function drawCards(state, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0 && !replenishDrawPile(state)) break;
    drawn.push(state.drawPile.pop());
  }
  return drawn;
}

// - Regolamento -

/**
 * Errore di dominio del motore
 */
class GameError extends Error {
  /**
   * @param {string} code    codice simbolico
   * @param {string} message messaggio leggibile
   * @param {number} status  status HTTP suggerito
   */
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Verifica se una carta puo' essere giocata sulla situazione corrente.
 *
 * @param {object} card         carta che si vuole giocare
 * @param {object} topCard      carta in cima alla pila degli scarti
 * @param {string} currentColor colore attivo
 * @param {number} pendingDraw  carte di pesca accumulate e non ancora subite
 * @param {string} [pendingDrawKind] tipo di carta (+2 o +4) che ha generato la
 *                              pesca pendente
 * @returns {boolean}
 */
function isPlayable(card, topCard, currentColor, pendingDraw = 0, pendingDrawKind = topCard.kind) {
  // Se c'e' una pesca pendente il giocatore puo' solo accumulare oppure subire
  // la pesca: nessun'altra carta e' giocabile
  if (pendingDraw > 0) {
    return canStack(card, pendingDrawKind, currentColor);
  }

  // I jolly sono sempre giocabili
  if (isWild(card)) return true;

  // Stesso colore attivo
  if (card.color === currentColor) return true;

  // Stesso numero
  if (card.kind === KIND.NUMBER && topCard.kind === KIND.NUMBER &&
      card.value === topCard.value) {
    return true;
  }

  // Stesso simbolo azione
  if (card.kind !== KIND.NUMBER && card.kind === topCard.kind) return true;

  return false;
}

/**
 * Risposta a un accumulo di pesca
 *
 * @param {object} card
 * @param {string} pendingDrawKind KIND.DRAW_TWO o KIND.WILD_DRAW_FOUR
 * @param {string} currentColor
 * @returns {boolean}
 */
function canStack(card, pendingDrawKind, currentColor) {
  if (pendingDrawKind === KIND.DRAW_TWO) {
    return card.kind === KIND.DRAW_TWO || card.kind === KIND.WILD_DRAW_FOUR;
  }
  if (pendingDrawKind === KIND.WILD_DRAW_FOUR) {
    return card.kind === KIND.WILD_DRAW_FOUR ||
           (card.kind === KIND.DRAW_TWO && card.color === currentColor);
  }
  return false;
}

// - giocata multipla -

/** Stesso numero o stessa figura */
function sameFigure(a, b) {
  return a.kind === b.kind && (a.kind !== KIND.NUMBER || a.value === b.value);
}

/**
 * true se le carte possono essere giocate insieme, nell'ordine dato
 * @param {Array<object>} cards la prima e' quella che apre la giocata
 * @returns {boolean}
 */
function canPlayTogether(cards) {
  return cards.every((c) => sameFigure(cards[0], c));
}

/**
 * Le carte di una mano che possono accompagnare 
 * `first` in una giocata multipla
 * @param {object} first
 * @param {Array<object>} hand
 * @returns {Array<object>}
 */
function followUpCards(first, hand) {
  return hand.filter((c) => c.id !== first.id && sameFigure(first, c));
}

/**
 * Elenca le carte giocabili di una mano
 */
function playableCards(hand, topCard, currentColor, pendingDraw = 0, pendingDrawKind = topCard.kind) {
  return hand.filter((c) => isPlayable(c, topCard, currentColor, pendingDraw, pendingDrawKind));
}

/**
 * Indice del giocatore successivo
 * @param {number} currentIndex
 * @param {number} playerCount
 * @param {number} direction  +1 senso orario, -1 antiorario
 * @param {number} steps      1 = prossimo, 2 = salta uno
 */
function nextPlayerIndex(currentIndex, playerCount, direction, steps = 1) {
  const raw = currentIndex + direction * steps;
  return ((raw % playerCount) + playerCount) % playerCount;
}

/** true se il colore passato e' uno dei quattro giocabili */
function isValidColor(color) {
  return COLORS.indexOf(color) !== -1;
}

/**
 * Punteggio della mano vinta
 */
function scoreRound(players, winnerId, pointsOfCard = pointsOf) {
  let total = 0;
  for (const p of players) {
    if (p.id === winnerId) continue;
    for (const card of p.hand) total += pointsOfCard(card);
  }
  return total;
}

// - Motore della partita -

/** Stati possibili di una partita */
const STATUS = {
  PLAYING: 'playing',   // partita in corso
  FINISHED: 'finished', // c'e' un vincitore
  ABORTED: 'aborted'    // interrotta (stanza eliminata, giocatori insufficienti)
};

/** Azioni accettate da applyAction() */
const ACTION = {
  PLAY_CARD: 'PLAY_CARD',
  DRAW_CARD: 'DRAW_CARD',
  PASS: 'PASS'
};

/** Motivi per cui un giocatore lascia una partita in corso */
const REMOVAL_REASON = {
  LEFT: 'left',                 // ha abbandonato di sua iniziativa
  KICKED: 'kicked',             // lo ha rimosso il proprietario della stanza
  DISCONNECTED: 'disconnected'  // non si fa vivo da troppo tempo
};

/** Motivi di interruzione di una partita */
const ABORT_REASON = {
  ROOM_DELETED: 'room_deleted',               // il proprietario ha eliminato la stanza
  OWNER_DISCONNECTED: 'owner_disconnected',   // il proprietario si e' disconnesso
  NOT_ENOUGH_PLAYERS: 'not_enough_players'    // e' rimasto un solo giocatore
};

// - creazione della partita -

/**
 * Crea lo stato iniziale di una partita
 * @param {object} params
 * @param {string} params.id            id della partita
 * @param {Array<{id:string, username:string}>} params.players  ordine di gioco
 * @param {number} [params.initialHand] carte iniziali per giocatore
 * @returns {object} stato della partita
 */
function createGame({ id, players, initialHand = 7 }) {
  if (!Array.isArray(players) || players.length < 2) {
    throw new GameError('NOT_ENOUGH_PLAYERS', 'Servono almeno 2 giocatori.', 400);
  }
  if (players.length > 10) {
    throw new GameError('TOO_MANY_PLAYERS', 'Massimo 10 giocatori.', 400);
  }

  const state = {
    id,
    status: STATUS.PLAYING,
    version: 1,
    players: players.map((p, index) => ({
      id: p.id,
      username: p.username,
      seat: index,
      hand: [],
      score: 0
    })),
    drawPile: shuffle(buildDeck()),
    discardPile: [],
    currentColor: null,
    currentPlayerIndex: 0,
    direction: 1,
    pendingDraw: 0,
    pendingDrawKind: null,
    pendingDecision: null,
    removedPlayers: [],
    winnerId: null,
    abortReason: null,
    createdAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString(),
    log: []
  };

  // Distribuzione delle mani
  for (let round = 0; round < initialHand; round++) {
    for (const player of state.players) {
      player.hand.push(...drawCards(state, 1));
    }
  }

  // Prima carta scoperta, vietato +4
  let first = drawCards(state, 1)[0];
  while (first && first.kind === KIND.WILD_DRAW_FOUR) {
    state.drawPile.unshift(first); 
    first = drawCards(state, 1)[0];
  }
  state.discardPile.push(first);

  state.currentColor = isWild(first)
    ? COLORS[Math.floor(Math.random() * 4)]
    : first.color;

  applyFirstCardEffect(state, first);

  pushEvent(state, 'GAME_STARTED', {
    players: state.players.map((p) => ({ id: p.id, username: p.username })),
    firstCard: labelOf(first),
    currentColor: state.currentColor
  });

  return state;
}

/** Effetti del regolamento sulla prima carta scoperta */
function applyFirstCardEffect(state, card) {
  const n = state.players.length;
  switch (card.kind) {
    case KIND.SKIP:
      state.currentPlayerIndex = nextPlayerIndex(0, n, state.direction, 1);
      break;
    case KIND.REVERSE:
      state.direction = -1;
      state.currentPlayerIndex = nextPlayerIndex(0, n, state.direction, 1);
      break;
    case KIND.DRAW_TWO:
      state.pendingDraw = 2;
      state.pendingDrawKind = KIND.DRAW_TWO;
      break;
    default:
      break;
  }
}

// - applicazione di un'azione -

/**
 * Applica un'azione allo stato
 * @param {object} state
 * @param {string} playerId  chi compie l'azione
 * @param {object} action    { type, cardId?, cardIds?, chosenColor? }
 * @returns {{state: object, events: Array<object>}}
 */
function applyAction(state, playerId, action) {
  const eventsBefore = state.log.length;

  if (state.status !== STATUS.PLAYING) {
    throw new GameError('GAME_NOT_ACTIVE', 'La partita non e\' in corso.', 409);
  }

  const player = findPlayer(state, playerId);

  switch (action.type) {
    case ACTION.PLAY_CARD:   handlePlayCard(state, player, action); break;
    case ACTION.DRAW_CARD:   handleDrawCard(state, player); break;
    case ACTION.PASS:        handlePass(state, player); break;
    default:
      throw new GameError('UNKNOWN_ACTION', `Azione non riconosciuta: ${action.type}`, 400);
  }

  return commit(state, eventsBefore);
}

/**
 * Chiude una modifica dello stato: incrementa la versione e la assegna agli
 * eventi appena prodotti
 */
function commit(state, eventsBefore) {
  state.version += 1;
  state.lastActionAt = new Date().toISOString();

  for (let i = eventsBefore; i < state.log.length; i++) {
    state.log[i].version = state.version;
  }

  return { state, events: state.log.slice(eventsBefore) };
}

/**
 * Gioca una o piu' carte
 */
function handlePlayCard(state, player, action) {
  requireTurn(state, player);

  const cardIds = Array.isArray(action.cardIds) ? action.cardIds : [action.cardId];

  if (cardIds.length === 0) {
    throw new GameError('NO_CARDS', 'Indica almeno una carta da giocare.', 400);
  }
  if (new Set(cardIds).size !== cardIds.length) {
    throw new GameError('DUPLICATE_CARD', 'La stessa carta compare due volte nella giocata.', 400);
  }

  const cards = cardIds.map((id) => {
    const card = player.hand.find((c) => c.id === id);
    if (!card) {
      throw new GameError('CARD_NOT_IN_HAND', 'La carta non e\' nella tua mano.', 400);
    }
    return card;
  });

  const first = cards[0];
  const last = cards[cards.length - 1];
  const topCard = topOfDiscard(state);

  if (!isPlayable(first, topCard, state.currentColor, state.pendingDraw,
                  pendingDrawKindOf(state))) {
    throw new GameError('ILLEGAL_MOVE',
      `Non puoi giocare ${labelOf(first)} su ${labelOf(topCard)} (colore attivo: ${state.currentColor}` +
      (state.pendingDraw > 0 ? `, pesca pendente: ${state.pendingDraw}` : '') + ').', 409);
  }

  if (!canPlayTogether(cards)) {
    throw new GameError('ILLEGAL_COMBO',
      `${cards.map(labelOf).join(', ')}: in una giocata multipla le carte devono avere ` +
      'tutte lo stesso numero o simbolo (il colore puo\' cambiare).', 409);
  }

  // Con piu' jolly insieme il colore si sceglie una volta sola, per l'ultimo.
  if (isWild(last) && !isValidColor(action.chosenColor)) {
    throw new GameError('COLOR_REQUIRED',
      'Giocando un jolly devi indicare un colore fra red, yellow, green, blue.', 400);
  }

  for (const card of cards) {
    player.hand.splice(player.hand.indexOf(card), 1);
    state.discardPile.push(card);
  }
  state.currentColor = isWild(last) ? action.chosenColor : last.color;
  state.pendingDecision = null;

  pushEvent(state, 'CARD_PLAYED', {
    playerId: player.id,
    card: cards.map(labelOf).join(', '),
    cardIds: cards.map((c) => c.id),
    count: cards.length,
    chosenColor: state.currentColor,
    handSize: player.hand.length
  });

  // Vittoria: mano vuota.
  if (player.hand.length === 0) {
    finishGame(state, player);
    return;
  }

  applyCardEffects(state, cards);
}

function handleDrawCard(state, player) {
  requireTurn(state, player);

  if (state.pendingDecision && state.pendingDecision.playerId === player.id) {
    throw new GameError('DECISION_PENDING',
      'Hai gia\' pescato: gioca la carta pescata oppure passa.', 409);
  }

  // C'e' una pesca accumulata da subire
  if (state.pendingDraw > 0) {
    const drawn = drawCards(state, state.pendingDraw);
    player.hand.push(...drawn);
    pushEvent(state, 'CARDS_DRAWN', {
      playerId: player.id,
      count: drawn.length,
      reason: 'penalty',
      handSize: player.hand.length
    });
    state.pendingDraw = 0;
    state.pendingDrawKind = null;
    advanceTurn(state, 1);
    return;
  }

  // Pesca normale di una carta
  const drawn = drawCards(state, 1);
  if (drawn.length === 0) {
    // Nessuna carta disponibile nemmeno riciclando gli scarti: stallo, si passa.
    pushEvent(state, 'DECK_EXHAUSTED', { playerId: player.id });
    advanceTurn(state, 1);
    return;
  }

  const card = drawn[0];
  player.hand.push(card);

  pushEvent(state, 'CARDS_DRAWN', {
    playerId: player.id,
    count: 1,
    reason: 'turn',
    handSize: player.hand.length
  });

  const topCard = topOfDiscard(state);
  const playable = isPlayable(card, topCard, state.currentColor, 0);

  if (playable) {
    state.pendingDecision = { playerId: player.id, cardId: card.id };
  } else {
    advanceTurn(state, 1);
  }
}

function handlePass(state, player) {
  requireTurn(state, player);

  if (!state.pendingDecision || state.pendingDecision.playerId !== player.id) {
    throw new GameError('CANNOT_PASS',
      'Puoi passare solo dopo aver pescato una carta giocabile.', 409);
  }

  state.pendingDecision = null;
  pushEvent(state, 'TURN_PASSED', { playerId: player.id });
  advanceTurn(state, 1);
}

/**
 * Effetti di una giocata, con piu' carte gli effetti si accumulano
 */
function applyCardEffects(state, cards) {
  const n = state.players.length;
  let skips = 0;

  for (const card of cards) {
    switch (card.kind) {
      case KIND.SKIP:
        skips += 1;
        break;

      case KIND.REVERSE:
        if (n === 2) {
          skips += 1;
        } else {
          state.direction *= -1;
          pushEvent(state, 'DIRECTION_REVERSED', { direction: state.direction });
        }
        break;

      case KIND.DRAW_TWO:
        state.pendingDraw += 2;
        state.pendingDrawKind = KIND.DRAW_TWO;
        break;

      case KIND.WILD_DRAW_FOUR:
        state.pendingDraw += 4;
        state.pendingDrawKind = KIND.WILD_DRAW_FOUR;
        break;

      case KIND.WILD:
      case KIND.NUMBER:
      default:
        break;
    }
  }

  if (skips > 0) {
    const skipped = [];
    for (let i = 1; i <= skips; i++) {
      const index = nextPlayerIndex(state.currentPlayerIndex, n, state.direction, i);
      skipped.push(state.players[index].id);
    }
    pushEvent(state, 'PLAYER_SKIPPED', { playerIds: skipped, count: skips });
  }

  advanceTurn(state, 1 + skips);
}

// - uscite dalla partita e interruzione -

/**
 * Toglie un giocatore dalla partita in corso
 * @param {object} state
 * @param {string} playerId
 * @param {string} [reason] uno dei valori di REMOVAL_REASON
 * @returns {{state: object, events: Array<object>}}
 */
function removePlayer(state, playerId, reason = REMOVAL_REASON.LEFT) {
  if (state.status !== STATUS.PLAYING) {
    throw new GameError('GAME_NOT_ACTIVE', 'La partita non e\' in corso.', 409);
  }

  const index = state.players.findIndex((p) => p.id === playerId);
  if (index === -1) {
    throw new GameError('PLAYER_NOT_IN_GAME', 'Il giocatore non partecipa a questa partita.', 404);
  }

  const eventsBefore = state.log.length;
  const wasCurrent = index === state.currentPlayerIndex;
  const [player] = state.players.splice(index, 1);

  state.drawPile.unshift(...player.hand);
  state.removedPlayers = (state.removedPlayers || []).concat({
    id: player.id, username: player.username, reason
  });

  pushEvent(state, 'PLAYER_REMOVED', {
    playerId: player.id,
    username: player.username,
    reason,
    cardsReturned: player.hand.length
  });

  const n = state.players.length;

  if (wasCurrent) {
    state.currentPlayerIndex = state.direction === 1 ? index % n : (index - 1 + n) % n;
  } else if (index < state.currentPlayerIndex) {
    state.currentPlayerIndex -= 1;
  }

  if (n < 2) {
    abort(state, ABORT_REASON.NOT_ENOUGH_PLAYERS);
  } else if (wasCurrent) {
    state.pendingDraw = 0;
    state.pendingDrawKind = null;
    state.pendingDecision = null;
    pushEvent(state, 'TURN_CHANGED', {
      playerId: state.players[state.currentPlayerIndex].id,
      pendingDraw: state.pendingDraw
    });
  }

  return commit(state, eventsBefore);
}

/**
 * Interrompe la partita in corso, senza vincitore ne' punteggi
 * @param {object} state
 * @param {string} reason uno dei valori di ABORT_REASON
 * @returns {{state: object, events: Array<object>}}
 */
function abortGame(state, reason) {
  if (state.status !== STATUS.PLAYING) {
    throw new GameError('GAME_NOT_ACTIVE', 'La partita non e\' in corso.', 409);
  }
  const eventsBefore = state.log.length;
  abort(state, reason);
  return commit(state, eventsBefore);
}

function abort(state, reason) {
  state.status = STATUS.ABORTED;
  state.abortReason = reason;
  state.pendingDecision = null;
  pushEvent(state, 'GAME_ABORTED', { reason });
}

function advanceTurn(state, steps) {
  state.currentPlayerIndex = nextPlayerIndex(
    state.currentPlayerIndex, state.players.length, state.direction, steps
  );
  state.pendingDecision = null;
  pushEvent(state, 'TURN_CHANGED', {
    playerId: state.players[state.currentPlayerIndex].id,
    pendingDraw: state.pendingDraw
  });
}

function finishGame(state, winner) {
  state.status = STATUS.FINISHED;
  state.winnerId = winner.id;
  winner.score = scoreRound(state.players, winner.id);
  pushEvent(state, 'GAME_FINISHED', {
    winnerId: winner.id,
    username: winner.username,
    score: winner.score
  });
}

function requireTurn(state, player) {
  if (state.players[state.currentPlayerIndex].id !== player.id) {
    throw new GameError('NOT_YOUR_TURN', 'Non e\' il tuo turno.', 409);
  }
}

function findPlayer(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    throw new GameError('PLAYER_NOT_IN_GAME', 'Non partecipi a questa partita.', 403);
  }
  return player;
}

function topOfDiscard(state) {
  return state.discardPile[state.discardPile.length - 1];
}

/**
 * Tipo della pesca pendente
 */
function pendingDrawKindOf(state) {
  if (state.pendingDraw <= 0) return null;
  return state.pendingDrawKind || topOfDiscard(state).kind;
}

function pushEvent(state, type, payload) {
  state.log.push({
    seq: state.log.length + 1,
    version: state.version,
    type,
    payload,
    at: new Date().toISOString()
  });
}

/**
 * Restituisce la vista dello stato che puo' essere inviata a un giocatore
 * @param {object} state
 * @param {string} playerId
 * @param {number} [sinceVersion] se indicato, il log e' filtrato da quella versione
 * @returns {object} stato pubblico + mano del richiedente
 */
function viewFor(state, playerId, sinceVersion = 0) {
  const me = state.players.find((p) => p.id === playerId);
  const topCard = topOfDiscard(state);
  const playable = me && topCard
    ? playableCards(me.hand, topCard, state.currentColor, state.pendingDraw,
                    pendingDrawKindOf(state))
    : [];

  return {
    id: state.id,
    status: state.status,
    version: state.version,
    currentColor: state.currentColor,
    direction: state.direction,
    pendingDraw: state.pendingDraw,
    pendingDrawKind: pendingDrawKindOf(state),
    topCard: topCard || null,
    drawPileSize: state.drawPile.length,
    discardPileSize: state.discardPile.length,
    currentPlayerId: state.players[state.currentPlayerIndex].id,
    winnerId: state.winnerId,
    abortReason: state.abortReason || null,
    players: state.players.map((p) => ({
      id: p.id,
      username: p.username,
      seat: p.seat,
      handSize: p.hand.length,
      score: p.score
    })),
    you: me ? {
      id: me.id,
      hand: me.hand,
      isYourTurn: state.players[state.currentPlayerIndex].id === me.id,
      playableCardIds: playable.map((c) => c.id),
      followUpCardIds: followUpsFor(me.hand, playable),
      pendingDecision: state.pendingDecision &&
                       state.pendingDecision.playerId === me.id
        ? state.pendingDecision
        : null
    } : null,
    events: state.log.filter((e) => e.version > sinceVersion)
  };
}

/**
 * Per ogni carta con cui si puo' aprire una giocata, 
 * le carte della mano che le si possono aggiungere
 * @returns {Object<string, Array<string>>} id carta -> id delle carte aggiungibili
 */
function followUpsFor(hand, playable) {
  const out = {};
  for (const card of playable) {
    out[card.id] = followUpCards(card, hand).map((c) => c.id);
  }
  return out;
}

module.exports = {
  // carte e mazzo
  COLORS, WILD, KIND,
  createCard, isWild, pointsOf, labelOf,
  buildDeck, shuffle, replenishDrawPile, drawCards,

  // regolamento
  GameError,
  isPlayable, canStack, sameFigure, canPlayTogether, followUpCards, playableCards,
  nextPlayerIndex, isValidColor, scoreRound,

  // motore
  STATUS, ACTION, REMOVAL_REASON, ABORT_REASON,
  createGame, applyAction, removePlayer, abortGame, viewFor
};
