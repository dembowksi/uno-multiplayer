'use strict';

/**
 * Stato delle stanze
 */

const EventEmitter = require('events');
const { config, roomRepository, gameRepository } = require('./db');
const game = require('./game');

// Canale di notifica dei cambiamenti di stato

class GameChannel extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Segnala che lo stato di una partita e' cambiato,
   * chiamata dopo ogni mossa applicata e salvata
   * @param {string} gameId
   * @param {number} version nuova versione dello stato
   */
  publish(gameId, version) {
    this.emit(`game:${gameId}`, version);
  }

  /**
   * Segnala che una stanza e' cambiata
   */
  publishRoom(roomId) {
    this.emit(`room:${roomId}`, true);
  }

  /**
   * Attende che la versione di una partita superi quella conosciuta dal client
   * @param {string} gameId
   * @param {number} sinceVersion versione gia' nota al client
   * @param {number} timeoutMs    attesa massima
   * @param {object} [req]        richiesta HTTP, per accorgersi se il client chiude
   * @returns {Promise<number|null>} la nuova versione, oppure null se scaduto il tempo
   */
  waitForChange(gameId, sinceVersion, timeoutMs, req = null) {
    return this.waitFor(`game:${gameId}`, (version) => version > sinceVersion, timeoutMs, req);
  }

  /**
   * Attende il prossimo cambiamento di una stanza
   * @returns {Promise<true|null>} true se e' cambiata, null se e' scaduto il tempo
   */
  waitForRoomChange(roomId, timeoutMs, req = null) {
    return this.waitFor(`room:${roomId}`, () => true, timeoutMs, req);
  }

  /**
   * Attesa generica di un evento
   * @param {string} eventName
   * @param {function(*): boolean} accept decide se il valore notificato basta
   * @param {number} timeoutMs
   * @param {object} [req]
   * @returns {Promise<*|null>} il valore notificato, oppure null
   */
  waitFor(eventName, accept, timeoutMs, req = null) {
    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        this.removeListener(eventName, onChange);
        clearTimeout(timer);
        if (req) req.removeListener('close', onClientGone);
      };

      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onChange = (value) => {
        // Ignora le notifiche che il client conosce gia'.
        if (accept(value)) finish(value);
      };

      const onClientGone = () => finish(null);

      const timer = setTimeout(() => finish(null), timeoutMs);

      this.on(eventName, onChange);
      if (req) req.once('close', onClientGone);
    });
  }
}

const gameChannel = new GameChannel();

// - Presenza dei giocatori nelle stanze -

class Presence {
  constructor() {
    this.entries = new Map();
  }

  entry(roomId, userId) {
    const key = `${roomId}:${userId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { lastSeen: Date.now(), open: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  touch(roomId, userId) {
    this.entry(roomId, userId).lastSeen = Date.now();
  }

  /**
   * L'utente tiene aperta una richiesta
   * @returns {function(): void}
   */
  hold(roomId, userId) {
    const entry = this.entry(roomId, userId);
    entry.open += 1;
    entry.lastSeen = Date.now();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.open -= 1;
      entry.lastSeen = Date.now();
    };
  }

  /**
   * true se l'utente non si fa vivo da piu' di `graceMs`
   */
  isAway(roomId, userId, graceMs) {
    const entry = this.entry(roomId, userId);
    return entry.open === 0 && Date.now() - entry.lastSeen > graceMs;
  }

  /** Dimentica un utente in una stanza  */
  forget(roomId, userId) {
    this.entries.delete(`${roomId}:${userId}`);
  }

  /** Dimentica una stanza intera */
  forgetRoom(roomId) {
    const prefix = `${roomId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

const presence = new Presence();

// - Ciclo di vita delle stanze -

const removals = new Map();

/** Motivo per cui l'utente e' uscito dalla stanza */
function removalReason(roomId, userId) {
  return removals.get(`${roomId}:${userId}`) || null;
}

/** L'utente e' rientrato nella stanza */
function forgetRemoval(roomId, userId) {
  removals.delete(`${roomId}:${userId}`);
}

/**
 * Elimina una stanza: la chiude, fa uscire tutti e annulla la partita in corso
 * @param {string} roomId
 * @param {string} reason game.ABORT_REASON.ROOM_DELETED o OWNER_DISCONNECTED
 * @returns {Promise<boolean>} true se la stanza e' stata chiusa da questa chiamata
 */
async function closeRoom(roomId, reason) {
  const closed = await roomRepository.closeRoom(roomId);
  presence.forgetRoom(roomId);
  for (const key of removals.keys()) {
    if (key.startsWith(`${roomId}:`)) removals.delete(key);
  }
  await updateActiveGame(roomId, (state) => game.abortGame(state, reason));
  gameChannel.publishRoom(roomId);

  return closed;
}

/**
 * Fa uscire un giocatore dalla stanza
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason uno dei valori di game.REMOVAL_REASON
 */
async function removePlayer(roomId, userId, reason) {
  await roomRepository.removePlayer(roomId, userId);
  presence.forget(roomId, userId);
  removals.set(`${roomId}:${userId}`, reason);

  const state = await updateActiveGame(roomId, (s) =>
    s.players.some((p) => p.id === userId) ? game.removePlayer(s, userId, reason) : null
  );
  if (state && state.status === game.STATUS.ABORTED) {
    await roomRepository.reopenAfterGame(roomId);
  }

  gameChannel.publishRoom(roomId);
}

/**
 * Un utente se ne va da tutte le stanze in cui si trova
 */
async function leaveAllRooms(userId) {
  const rooms = await roomRepository.listActiveRoomsOf(userId);
  for (const room of rooms) {
    if (room.owner_id === userId) {
      await closeRoom(room.id, game.ABORT_REASON.OWNER_DISCONNECTED);
    } else {
      await removePlayer(room.id, userId, game.REMOVAL_REASON.LEFT);
    }
  }
}

/**
 * Gestisce chi risulta disconnesso
 * @returns {Promise<{roomsClosed: number, guestsRemoved: number}>}
 */
async function handleDisconnections() {
  const grace = config.rooms.disconnectGraceMs;

  const rooms = new Map();
  for (const row of await roomRepository.listActiveMembers()) {
    if (!rooms.has(row.room_id)) rooms.set(row.room_id, { ownerId: row.owner_id, guests: [] });
    if (row.user_id && row.user_id !== row.owner_id) rooms.get(row.room_id).guests.push(row.user_id);
  }

  const result = { roomsClosed: 0, guestsRemoved: 0 };

  for (const [roomId, room] of rooms) {
    if (presence.isAway(roomId, room.ownerId, grace)) {
      await closeRoom(roomId, game.ABORT_REASON.OWNER_DISCONNECTED);
      result.roomsClosed += 1;
      continue;
    }
    for (const userId of room.guests) {
      if (presence.isAway(roomId, userId, grace)) {
        await removePlayer(roomId, userId, game.REMOVAL_REASON.DISCONNECTED);
        result.guestsRemoved += 1;
      }
    }
  }

  return result;
}

/**
 * Applica una modifica alla partita in corso nella stanza
 * @param {string} roomId
 * @param {function(object): (object|null)} change  modifica lo stato; null = niente da fare
 * @returns {Promise<object|null>} lo stato salvato, oppure null
 */
async function updateActiveGame(roomId, change) {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const active = await gameRepository.findActiveByRoom(roomId);
    if (!active) return null;

    const state = await gameRepository.loadState(active.id);
    if (!state || state.status !== game.STATUS.PLAYING) return null;

    const versionBefore = state.version;
    const result = change(state);
    if (!result) return null;

    try {
      await gameRepository.saveState(state, versionBefore);
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT' && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }

    gameChannel.publish(state.id, state.version);
    return state;
  }
  return null;
}

module.exports = {
  gameChannel,
  presence,
  closeRoom,
  removePlayer,
  leaveAllRooms,
  handleDisconnections,
  removalReason,
  forgetRemoval
};
