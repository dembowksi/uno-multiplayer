'use strict';

/**
 * API REST 
 */

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const game = require('./game');
const roomService = require('./rooms');

const { config, userRepository, roomRepository, gameRepository } = db;
const { gameChannel, presence } = roomService;

const router = express.Router();

/** Errore applicativo con codice simbolico e status HTTP. */
function fail(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

// - autenticazione -

function extractToken(req) {
  const header = req.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await userRepository.findUserByToken(extractToken(req));

    if (!user) {
      res.set('WWW-Authenticate', 'Bearer realm="uno-online"');
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Token assente, non valido o scaduto.' }
      });
    }

    req.user = user;
    req.token = extractToken(req);
    next();
  } catch (err) {
    next(err);
  }
}

async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (token) {
      const user = await userRepository.findUserByToken(token);
      if (user) {
        req.user = user;
        req.token = token;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// - log -

/**
 * Metodo, percorso, status e durata di ogni richiesta
 */
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tag = req.query && req.query.wait === '1' ? ' [long-poll]' : '';
    const user = req.user ? ` user=${req.user.username}` : '';

    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ` +
      `-> ${res.statusCode} ${ms.toFixed(1)}ms${tag}${user}`
    );
  });

  next();
}

// - errori -

function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Nessuna risorsa a ${req.method} ${req.originalUrl}.`
    }
  });
}

function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';

  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: "Il corpo della richiesta non e' JSON valido." }
    });
  }

  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      error: { code: 'DUPLICATE', message: "Valore gia' esistente." }
    });
  }

  res.status(status).json({
    error: {
      code,
      message: status >= 500 ? 'Errore interno del server.' : err.message }
  });
}

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// GET /api/health - stato del servizio

router.get('/health', async (req, res) => {
  const health = await db.healthCheck();
  res.status(health.ok ? 200 : 503).json({
    status: health.ok ? 'ok' : 'degraded',
    database: health.message,
    uptimeSeconds: Math.round(process.uptime())
  });
});

// - Utenti e sessioni -

// Vincoli sui dati in ingresso
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_MIN = 8;

/** Valida username e password */
function validateCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    throw fail('INVALID_USERNAME',
      'Il nome utente deve avere da 3 a 32 caratteri fra lettere, cifre, punto, trattino e underscore.', 400);
  }
  if (password.length < PASSWORD_MIN) {
    throw fail('WEAK_PASSWORD',
      `La password deve avere almeno ${PASSWORD_MIN} caratteri.`, 400);
  }
  return { username, password };
}

// POST /api/users - registrazione
router.post('/users', asyncHandler(async (req, res) => {
  const { username, password } = validateCredentials(req.body || {});

  if (await userRepository.usernameExists(username)) {
    return res.status(409).json({
      error: { code: 'USERNAME_TAKEN', message: 'Nome utente gia\' in uso.' }
    });
  }

  const user = await userRepository.createUser(username, password);

  // 201 Created: e' nata una nuova risorsa.
  res.status(201).json({ id: user.id, username: user.username });
}));

// POST /api/sessions - login
router.post('/sessions', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) {
    throw fail('MISSING_CREDENTIALS', 'Servono username e password.', 400);
  }

  const user = await userRepository.authenticate(username, password);
  if (!user) {
    res.set('WWW-Authenticate', 'Bearer realm="uno-online"');
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Credenziali non valide.' }
    });
  }

  const session = await userRepository.createSession(user.id, req.get('User-Agent'));

  res.status(201).json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, username: user.username }
  });
}));

// GET /api/sessions/current - chi sono
router.get('/sessions/current', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// DELETE /api/sessions/current - logout
router.delete('/sessions/current', requireAuth, asyncHandler(async (req, res) => {
  await roomService.leaveAllRooms(req.user.id);
  await userRepository.deleteSession(req.token);
  res.status(204).end();   // 204: operazione riuscita, nessun corpo da restituire
}));

// - Stanze (lobby) e creazione delle partite -

//   /api/rooms                      collezione delle stanze
//   /api/rooms/:id                  una stanza
//   /api/rooms/:id/players          i partecipanti di quella stanza
//   /api/rooms/:id/players/:userId  un partecipante
//   /api/rooms/:id/games            le partite giocate in quella stanza


/**
 * Carica una stanza ancora esistente
 */
async function loadOpenRoom(roomId) {
  const room = await roomRepository.findById(roomId);
  if (!room) throw fail('ROOM_NOT_FOUND', 'Stanza inesistente.', 404);
  if (room.status === 'closed') {
    throw fail('ROOM_DELETED',
      'La stanza e\' stata eliminata: il proprietario l\'ha chiusa o si e\' disconnesso.', 410);
  }
  return room;
}

/**
 * Dettaglio della stanza
 */
async function roomPayload(roomId) {
  const room = await loadOpenRoom(roomId);
  const active = await gameRepository.findActiveByRoom(room.id);

  room.activeGame = active ? { id: active.id } : null;
  room.version = crypto
    .createHash('sha1')
    .update(JSON.stringify([
      room.status,
      active ? active.id : null,
      room.players.map((p) => [p.id, p.seat])
    ]))
    .digest('hex')
    .slice(0, 16);

  return room;
}

function withYou(payload, userId) {
  const member = payload.players.some((p) => p.id === userId);
  return Object.assign({}, payload, {
    you: {
      member,
      removedReason: member ? null : roomService.removalReason(payload.id, userId)
    }
  });
}

// GET /api/rooms - stanze pubbliche aperte
router.get('/rooms', requireAuth, asyncHandler(async (req, res) => {
  res.json({ items: await roomRepository.listOpenRooms() });
}));

// POST /api/rooms - crea una stanza
router.post('/rooms', requireAuth, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const maxPlayers = Number(body.maxPlayers) || config.game.maxPlayers;

  if (name.length < 3 || name.length > 64) {
    throw fail('INVALID_NAME', 'Il nome della stanza deve avere da 3 a 64 caratteri.', 400);
  }
  if (maxPlayers < config.game.minPlayers || maxPlayers > 10) {
    throw fail('INVALID_MAX_PLAYERS',
      `Il numero di giocatori deve essere fra ${config.game.minPlayers} e 10.`, 400);
  }

  const room = await roomRepository.createRoom({ name, ownerId: req.user.id, maxPlayers });

  presence.touch(room.id, req.user.id);

  res.status(201).location(`/api/rooms/${room.id}`).json(room);
}));

// GET /api/rooms/:id - dettaglio stanza, con long-polling
router.get('/rooms/:id', requireAuth, asyncHandler(async (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  const wait = req.query.wait === '1';

  let payload = await roomPayload(req.params.id);
  const member = payload.players.some((p) => p.id === req.user.id);
  if (member) presence.touch(payload.id, req.user.id);

  res.set('Cache-Control', 'no-store');

  if (!wait || !member || payload.version !== since) {
    return res.json(withYou(payload, req.user.id));
  }

  const release = presence.hold(payload.id, req.user.id);
  let changed;
  try {
    changed = await gameChannel.waitForRoomChange(payload.id, config.sync.longPollTimeoutMs, req);
  } finally {
    release();
  }

  if (!changed) return res.status(204).end();

  payload = await roomPayload(req.params.id);
  res.json(withYou(payload, req.user.id));
}));

// DELETE /api/rooms/:id - elimina la stanza (solo il proprietario)
router.delete('/rooms/:id', requireAuth, asyncHandler(async (req, res) => {
  const room = await roomRepository.findById(req.params.id);
  if (!room) throw fail('ROOM_NOT_FOUND', 'Stanza inesistente.', 404);
  if (room.owner_id !== req.user.id) {
    throw fail('FORBIDDEN', 'Solo il proprietario puo\' eliminare la stanza.', 403);
  }

  if (room.status !== 'closed') {
    await roomService.closeRoom(room.id, game.ABORT_REASON.ROOM_DELETED);
  }

  res.status(204).end();
}));

// POST /api/rooms/:id/players - entra nella stanza
router.post('/rooms/:id/players', requireAuth, asyncHandler(async (req, res) => {
  const result = await roomRepository.addPlayer(req.params.id, req.user.id);
  const room = await roomRepository.findById(req.params.id);

  presence.touch(room.id, req.user.id);
  roomService.forgetRemoval(room.id, req.user.id);
  gameChannel.publishRoom(room.id);

  res.status(201)
     .location(`/api/rooms/${req.params.id}/players/${req.user.id}`)
     .json({ seat: result.seat, room });
}));

// DELETE /api/rooms/:id/players/:userId - esci, oppure rimuovi un giocatore
router.delete('/rooms/:id/players/:userId', requireAuth, asyncHandler(async (req, res) => {
  const room = await loadOpenRoom(req.params.id);
  const targetId = req.params.userId;
  const isOwner = room.owner_id === req.user.id;
  if (isOwner) presence.touch(room.id, req.user.id);

  if (targetId === room.owner_id) {
    throw fail('OWNER_CANNOT_LEAVE',
      'Il proprietario non puo\' uscire dalla stanza: puo\' solo eliminarla.', 409);
  }
  if (targetId !== req.user.id && !isOwner) {
    throw fail('FORBIDDEN', 'Solo il proprietario puo\' rimuovere altri giocatori.', 403);
  }
  if (!room.players.some((p) => p.id === targetId)) {
    throw fail('PLAYER_NOT_IN_ROOM', 'Il giocatore non fa parte della stanza.', 404);
  }

  const reason = targetId === req.user.id
    ? game.REMOVAL_REASON.LEFT
    : game.REMOVAL_REASON.KICKED;

  await roomService.removePlayer(room.id, targetId, reason);

  res.status(204).end();
}));

// POST /api/rooms/:id/games - avvia una partita
router.post('/rooms/:id/games', requireAuth, asyncHandler(async (req, res) => {
  const room = await roomRepository.findById(req.params.id);
  if (!room) throw fail('ROOM_NOT_FOUND', 'Stanza inesistente.', 404);
  if (room.owner_id !== req.user.id) {
    throw fail('FORBIDDEN', 'Solo chi ha creato la stanza puo\' avviare la partita.', 403);
  }
  presence.touch(room.id, req.user.id);
  if (room.status !== 'open') {
    throw fail('ROOM_NOT_OPEN', 'La stanza non e\' in attesa di giocatori.', 409);
  }

  const players = room.players;
  if (players.length < config.game.minPlayers) {
    throw fail('NOT_ENOUGH_PLAYERS',
      `Servono almeno ${config.game.minPlayers} giocatori, ce ne sono ${players.length}.`, 409);
  }

  const existing = await gameRepository.findActiveByRoom(room.id);
  if (existing) {
    throw fail('GAME_ALREADY_RUNNING', 'C\'e\' gia\' una partita in corso in questa stanza.', 409);
  }

  const id = crypto.randomUUID();

  const state = game.createGame({
    id,
    players: players.map((p) => ({ id: p.id, username: p.username })),
    initialHand: config.game.initialHand
  });

  await gameRepository.createGame(room.id, state);
  await roomRepository.setStatus(room.id, 'playing');

  gameChannel.publishRoom(room.id);

  res.status(201)
     .location(`/api/games/${id}`)
     .json({
       id,
       roomId: room.id,
       state: Object.assign(game.viewFor(state, req.user.id), {
         roomId: room.id,
         ownerId: room.owner_id
       })
     });
}));

// - Partita -

const REMOVAL_MESSAGE = {
  [game.REMOVAL_REASON.KICKED]: 'Il proprietario della stanza ti ha rimosso dalla partita.',
  [game.REMOVAL_REASON.DISCONNECTED]:
    'La connessione con il server si e\' interrotta troppo a lungo: sei fuori dalla partita.',
  [game.REMOVAL_REASON.LEFT]: 'Hai abbandonato questa partita.'
};

/**
 * Carica lo stato verificando che il chiamante ne faccia parte
 */
async function loadGameFor(gameId, userId) {
  const state = await gameRepository.loadState(gameId);
  if (!state) throw fail('GAME_NOT_FOUND', 'Partita inesistente.', 404);

  if (!state.players.some((p) => p.id === userId)) {
    const removed = (state.removedPlayers || []).find((p) => p.id === userId);
    if (removed) {
      throw fail('REMOVED_FROM_GAME', REMOVAL_MESSAGE[removed.reason] || REMOVAL_MESSAGE.left, 403);
    }
    throw fail('FORBIDDEN', 'Non partecipi a questa partita.', 403);
  }
  return state;
}

/**
 * Invia la proiezione dello stato per un giocatore
 */
function sendState(res, state, userId, since, room) {
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign(game.viewFor(state, userId, since), {
    roomId: room.roomId,
    ownerId: room.ownerId
  }));
}

// GET /api/games/:id - stato della partita per il chiamante
router.get('/games/:id', requireAuth, asyncHandler(async (req, res) => {
  const gameId = req.params.id;
  const since = Number(req.query.since) || 0;
  const wait = req.query.wait === '1';

  const current = await gameRepository.currentVersion(gameId);
  if (!current) throw fail('GAME_NOT_FOUND', 'Partita inesistente.', 404);

  let state = await loadGameFor(gameId, req.user.id);
  presence.touch(current.roomId, req.user.id);

  if (state.version > since || !wait || state.status !== game.STATUS.PLAYING) {
    return sendState(res, state, req.user.id, since, current);
  }

  // Long-polling 
  res.set('Cache-Control', 'no-store');

  const release = presence.hold(current.roomId, req.user.id);
  let newVersion;
  try {
    newVersion = await gameChannel.waitForChange(
      gameId, since, config.sync.longPollTimeoutMs, req
    );
  } finally {
    release();
  }

  if (newVersion === null) {
    return res.status(204).end();
  }

  state = await loadGameFor(gameId, req.user.id);
  return sendState(res, state, req.user.id, since, current);
}));

// POST /api/games/:id/moves - invia una mossa
router.post('/games/:id/moves', requireAuth, asyncHandler(async (req, res) => {
  const gameId = req.params.id;
  const action = req.body || {};

  if (!action.type || !Object.values(game.ACTION).includes(action.type)) {
    throw fail('INVALID_ACTION',
      `type deve essere uno di: ${Object.values(game.ACTION).join(', ')}.`, 400);
  }
  if (action.cardIds !== undefined && !Array.isArray(action.cardIds)) {
    throw fail('INVALID_ACTION', 'cardIds deve essere un array di id di carte.', 400);
  }

  const room = await gameRepository.currentVersion(gameId);
  if (!room) throw fail('GAME_NOT_FOUND', 'Partita inesistente.', 404);

  const state = await loadGameFor(gameId, req.user.id);
  const versionBefore = state.version;
  presence.touch(room.roomId, req.user.id);

  if (action.expectedVersion !== undefined &&
      Number(action.expectedVersion) !== versionBefore) {
    throw fail('VERSION_CONFLICT',
      `Lo stato e' cambiato (tu: ${action.expectedVersion}, server: ${versionBefore}). Ricarica.`, 409);
  }

  game.applyAction(state, req.user.id, action);

  await gameRepository.saveState(state, versionBefore);

  if (state.status === game.STATUS.FINISHED) {
    await roomRepository.reopenAfterGame(room.roomId);
    gameChannel.publishRoom(room.roomId);
  }

  gameChannel.publish(gameId, state.version);

  res.status(201)
     .location(`/api/games/${gameId}`)
     .json(Object.assign(game.viewFor(state, req.user.id, versionBefore), {
       accepted: true,
       roomId: room.roomId,
       ownerId: room.ownerId
     }));
}));

module.exports = { router, optionalAuth, requestLogger, notFound, errorHandler };
