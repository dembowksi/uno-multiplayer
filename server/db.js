'use strict';

/**
 * Configurazione e accesso ai dati
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// - Configurazione -

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

const config = {
  env: process.env.NODE_ENV || 'development',

  http: {
    host: process.env.HOST || '127.0.0.1',
    port: num(process.env.PORT, 5678)
  },

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'uno',
    password: process.env.DB_PASSWORD || 'uno',
    database: process.env.DB_NAME || 'uno_online',
    connectionLimit: num(process.env.DB_POOL_SIZE, 10)
  },

  session: {
    secret: process.env.SESSION_SECRET || 'sviluppo-non-usare-in-produzione',
    ttlMinutes: num(process.env.SESSION_TTL_MINUTES, 720)
  },

  sync: {
    longPollTimeoutMs: num(process.env.LONGPOLL_TIMEOUT_MS, 25000)
  },

  game: {
    minPlayers: num(process.env.GAME_MIN_PLAYERS, 2),
    maxPlayers: num(process.env.GAME_MAX_PLAYERS, 4),
    initialHand: num(process.env.GAME_INITIAL_HAND, 7)
  },

  rooms: {
    // Dopo quanto tempo senza richieste un utente e' considerato disconnesso
    disconnectGraceMs: num(process.env.ROOM_DISCONNECT_GRACE_MS, 20000),
    // Ogni quanto il server controlla chi e' ancora collegato alle stanze.
    sweepIntervalMs: num(process.env.ROOM_SWEEP_INTERVAL_MS, 5000)
  }
};

config.warnings = [];
if (config.env === 'production' && config.session.secret.startsWith('sviluppo')) {
  config.warnings.push('SESSION_SECRET non impostato: i token di sessione sono prevedibili.');
}

// - Crittografia (modulo crypto di Node) -

const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

/**
 * Calcola il digest di una password con PBKDF2
 *
 * @param {string} password
 * @param {string} [salt] sale esadecimale; se assente ne viene generato uno
 * @returns {{salt: string, hash: string}}
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString('hex');
  return { salt, hash };
}

/**
 * Verifica una password contro sale e digest memorizzati
 */
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * HMAC-SHA256 di un token di sessione
 * @returns {string} 64 caratteri esadecimali
 */
function hashToken(token) {
  return crypto
    .createHmac('sha256', config.session.secret)
    .update(token)
    .digest('hex');
}

// - Connessione -

let pool = null;

/** 
 * Crea il pool alla prima richiesta, le chiamate successive lo riusano
 */
function getPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    queueLimit: 0,
    dateStrings: true,
    timezone: 'Z'
  });

  return pool;
}

/**
 * Esegue una query e ritorna le righe
 * @returns {Promise<Array<object>>}
 */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/**
 * Esegue una query che modifica dati e ritorna i metadati
 * @returns {Promise<{affectedRows:number, insertId:number}>}
 */
async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Esegue una funzione dentro una transazione, con commit o rollback automatici
 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Verifica che il database sia raggiungibile e che lo schema sia stato creato
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function healthCheck() {
  try {
    await query('SELECT 1');
  } catch (err) {
    return {
      ok: false,
      message: `MySQL non raggiungibile su ${config.db.host}:${config.db.port} (${err.code || err.message}). ` +
               'Controlla che il servizio sia avviato e le credenziali in .env.'
    };
  }

  try {
    await query('SELECT 1 FROM users LIMIT 1');
  } catch (err) {
    return {
      ok: false,
      message: 'Connessione riuscita ma lo schema manca. Esegui: mysql -u root -p < db/schema.sql'
    };
  }

  return { ok: true, message: `MySQL connesso: ${config.db.database}@${config.db.host}` };
}

/** 
 * Chiude il pool 
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// - Utenti e sessioni -

/**
 * Registra un nuovo utente
 * @param {string} username
 * @param {string} password  in chiaro, viene subito trasformata in digest
 * @returns {Promise<{id:string, username:string}>}
 */
async function createUser(username, password) {
  const id = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);

  await execute(
    'INSERT INTO users (id, username, password_salt, password_hash) VALUES (?, ?, ?, ?)',
    [id, username, salt, hash]
  );

  return { id, username };
}

function findByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

async function usernameExists(username) {
  const row = await queryOne('SELECT 1 AS x FROM users WHERE username = ?', [username]);
  return row !== null;
}

/**
 * Verifica le credenziali.
 * @returns {Promise<object|null>} l'utente oppure null se non tornano
 */
async function authenticate(username, password) {
  const user = await findByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;

  await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  return { id: user.id, username: user.username };
}

/**
 * Apre una sessione e ritorna il token da consegnare al client
 * @returns {Promise<{token:string, expiresAt:string}>}
 */
async function createSession(userId, userAgent = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.session.ttlMinutes * 60000);

  await execute(
    'INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    [hashToken(token), userId, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
     userAgent ? userAgent.slice(0, 255) : null]
  );

  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Risolve un token nell'utente corrispondente
 * @returns {Promise<object|null>} utente, oppure null se token assente o scaduto
 */
async function findUserByToken(token) {
  if (!token) return null;

  return queryOne(
    `SELECT u.id, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > NOW()`,
    [hashToken(token)]
  );
}

function deleteSession(token) {
  return execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

function purgeExpiredSessions() {
  return execute('DELETE FROM sessions WHERE expires_at <= NOW()');
}

// - Stanze -

/**
 * Crea una stanza e vi iscrive il proprietario
 * @returns {Promise<object>} la stanza appena creata
 */
async function createRoom({ name, ownerId, maxPlayers = config.game.maxPlayers }) {
  const id = crypto.randomUUID();

  await transaction(async (conn) => {
    await conn.execute(
      'INSERT INTO rooms (id, name, owner_id, max_players) VALUES (?, ?, ?, ?)',
      [id, name, ownerId, maxPlayers]
    );
    await conn.execute(
      'INSERT INTO room_players (room_id, user_id, seat) VALUES (?, ?, 0)',
      [id, ownerId]
    );
  });

  return findById(id);
}

/** 
 * Stanza con l'elenco dei partecipanti
 */
async function findById(roomId) {
  const room = await queryOne(
    `SELECT r.id, r.name, r.owner_id, r.status, r.max_players, r.created_at,
            u.username AS owner_username
       FROM rooms r
       JOIN users u ON u.id = r.owner_id
      WHERE r.id = ?`,
    [roomId]
  );
  if (!room) return null;

  room.players = await listPlayers(roomId);
  return room;
}

/**
 * Stanze ancora aperte, con il numero di iscritti.
 * @returns {Promise<Array<object>>}
 */
function listOpenRooms(limit = 50) {
  return query(
    `SELECT r.id, r.name, r.status, r.max_players, r.created_at,
            u.username AS owner_username,
            (SELECT COUNT(*) FROM room_players rp
              WHERE rp.room_id = r.id AND rp.left_at IS NULL) AS player_count
       FROM rooms r
       JOIN users u ON u.id = r.owner_id
      WHERE r.status = 'open'
      ORDER BY r.created_at DESC
      LIMIT ?`,
    [String(limit)]
  );
}

/** 
 * Partecipanti attivi
 */
function listPlayers(roomId) {
  return query(
    `SELECT rp.user_id AS id, u.username, rp.seat, rp.joined_at
       FROM room_players rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = ? AND rp.left_at IS NULL
      ORDER BY rp.seat`,
    [roomId]
  );
}

/**
 * Iscrive un giocatore alla stanza
 *
 * @returns {Promise<{seat:number}>}
 * @throws {Error} con .code = 'ROOM_NOT_FOUND' | 'ROOM_CLOSED' | 'ROOM_FULL'
 */
async function addPlayer(roomId, userId) {
  return transaction(async (conn) => {
    const [rooms] = await conn.execute(
      'SELECT status, max_players FROM rooms WHERE id = ? FOR UPDATE', [roomId]
    );
    if (rooms.length === 0) {
      throw Object.assign(new Error('Stanza inesistente.'), { code: 'ROOM_NOT_FOUND', status: 404 });
    }
    if (rooms[0].status !== 'open') {
      throw Object.assign(new Error('La stanza non accetta nuovi giocatori.'), { code: 'ROOM_CLOSED', status: 409 });
    }

    const [existing] = await conn.execute(
      'SELECT seat, left_at FROM room_players WHERE room_id = ? AND user_id = ?', [roomId, userId]
    );
    if (existing.length > 0 && existing[0].left_at === null) {
      return { seat: existing[0].seat, rejoined: false };
    }

    const [occupied] = await conn.execute(
      'SELECT seat FROM room_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat', [roomId]
    );
    if (occupied.length >= rooms[0].max_players) {
      throw Object.assign(new Error('Stanza piena.'), { code: 'ROOM_FULL', status: 409 });
    }

    // primo posto libero
    const taken = new Set(occupied.map((r) => r.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;

    if (existing.length > 0) {
      await conn.execute(
        'UPDATE room_players SET seat = ?, left_at = NULL WHERE room_id = ? AND user_id = ?',
        [seat, roomId, userId]
      );
      return { seat, rejoined: true };
    }

    await conn.execute(
      'INSERT INTO room_players (room_id, user_id, seat) VALUES (?, ?, ?)', [roomId, userId, seat]
    );
    return { seat, rejoined: false };
  });
}

/** 
 * Segna l'uscita di un giocatore
  */
function removePlayer(roomId, userId) {
  return execute(
    'UPDATE room_players SET left_at = NOW() WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    [roomId, userId]
  );
}

/** 
 * Cambia lo stato della stanza
 */
function setStatus(roomId, status) {
  const closedAt = status === 'closed' ? 'NOW()' : 'NULL';
  return execute(
    `UPDATE rooms SET status = ?, closed_at = ${closedAt} WHERE id = ?`,
    [status, roomId]
  );
}

/**
 * Riapre la stanza a fine partita
 */
function reopenAfterGame(roomId) {
  return execute(
    'UPDATE rooms SET status = \'open\' WHERE id = ? AND status = \'playing\'',
    [roomId]
  );
}

/**
 * Chiude la stanza e ne fa uscire tutti i partecipanti
 * @returns {Promise<boolean>} true se la stanza era aperta ed e' stata chiusa ora
 */
async function closeRoom(roomId) {
  return transaction(async (conn) => {
    const [result] = await conn.execute(
      'UPDATE rooms SET status = \'closed\', closed_at = NOW() WHERE id = ? AND status <> \'closed\'',
      [roomId]
    );
    await conn.execute(
      'UPDATE room_players SET left_at = NOW() WHERE room_id = ? AND left_at IS NULL',
      [roomId]
    );
    return result.affectedRows > 0;
  });
}

/**
 * Stanze non ancora chiuse con i loro partecipanti
 */
function listActiveMembers() {
  return query(
    `SELECT r.id AS room_id, r.owner_id, rp.user_id
       FROM rooms r
       LEFT JOIN room_players rp ON rp.room_id = r.id AND rp.left_at IS NULL
      WHERE r.status IN ('open', 'playing')`
  );
}

/** 
 * Stanze non chiuse di cui l'utente fa parte
 */
function listActiveRoomsOf(userId) {
  return query(
    `SELECT r.id, r.owner_id, r.status
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
      WHERE rp.user_id = ? AND rp.left_at IS NULL
        AND r.status IN ('open', 'playing')`,
    [userId]
  );
}

// - Partite -

/** 
 * Salva una partita appena creata
 */
function createGame(roomId, state) {
  return execute(
    'INSERT INTO games (id, room_id, status, version, state) VALUES (?, ?, ?, ?, ?)',
    [state.id, roomId, state.status, state.version, JSON.stringify(state)]
  );
}

/**
 * Carica lo stato completo di una partita.
 * @returns {Promise<object|null>} lo stato deserializzato
 */
async function loadState(gameId) {
  const row = await queryOne('SELECT state FROM games WHERE id = ?', [gameId]);
  if (!row) return null;
  return typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
}

/**
 * Versione corrente 
 */
async function currentVersion(gameId) {
  const row = await queryOne(
    `SELECT g.version, g.status, g.room_id, r.owner_id
       FROM games g
       JOIN rooms r ON r.id = g.room_id
      WHERE g.id = ?`,
    [gameId]
  );
  return row
    ? { version: row.version, status: row.status, roomId: row.room_id, ownerId: row.owner_id }
    : null;
}

/**
 * Salva lo stato dopo una mossa
 * @param {object} state          nuovo stato, con version gia' incrementata
 * @param {number} expectedVersion versione letta prima di applicare la mossa
 * @throws {Error} con .code = 'VERSION_CONFLICT'
 */
async function saveState(state, expectedVersion) {
  const result = await execute(
    `UPDATE games
        SET state = ?, version = ?, status = ?, winner_id = ?,
            finished_at = CASE WHEN ? = 'finished' THEN NOW() ELSE finished_at END
      WHERE id = ? AND version = ?`,
    [JSON.stringify(state), state.version, state.status, state.winnerId,
     state.status, state.id, expectedVersion]
  );

  if (result.affectedRows === 0) {
    throw Object.assign(
      new Error('La partita e\' stata modificata da un\'altra richiesta. Ricarica lo stato.'),
      { code: 'VERSION_CONFLICT', status: 409 }
    );
  }
}

/** 
 * Partita in corso in una stanza, se esiste
 */
function findActiveByRoom(roomId) {
  return queryOne(
    'SELECT id, version, status FROM games WHERE room_id = ? AND status = \'playing\' ORDER BY started_at DESC LIMIT 1',
    [roomId]
  );
}

module.exports = {
  config,
  healthCheck,
  close,

  userRepository: {
    createUser,
    usernameExists,
    authenticate,
    createSession,
    findUserByToken,
    deleteSession,
    purgeExpiredSessions
  },

  roomRepository: {
    createRoom,
    findById,
    listOpenRooms,
    addPlayer,
    removePlayer,
    setStatus,
    reopenAfterGame,
    closeRoom,
    listActiveMembers,
    listActiveRoomsOf
  },

  gameRepository: {
    createGame,
    loadState,
    currentVersion,
    saveState,
    findActiveByRoom
  }
};
