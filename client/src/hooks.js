import { useState, useEffect, useCallback } from 'react';

/**
 *   api          client HTTP dell'API REST
 *   useSession   chi e' l'utente, come entra e come esce
 *   useSync      ciclo che tiene aggiornato un dato del server
 *   useRoomSync  long-polling della stanza
 *   useGameSync  long-polling dello stato della partita, e invio delle mosse
 */

// - client HTTP -

const BASE = '/api';

const TIMEOUT_MS = 15000;
const LONG_POLL_TIMEOUT_MS = 40000;

let token = null;

/**
 * Errore HTTP
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'Errore di rete');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'NETWORK_ERROR';
  }
}

/**
 * Esegue una richiesta HTTP.
 *
 * @param {string} method                 GET, POST, DELETE
 * @param {string} path                   percorso relativo
 * @param {object} [options]
 * @param {object} [options.body]         corpo da serializzare in JSON
 * @param {number} [options.timeoutMs]    timeout della richiesta
 * @param {AbortSignal} [options.signal]  per annullare la richiesta
 * @returns {Promise<object|null>}        corpo deserializzato, null se 204
 */
async function request(method, path, { body, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', cancel);
  }

  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    if (res.status === 204) return null;

    let payload = null;
    try {
      const text = await res.text();
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(res.status, 'INVALID_RESPONSE',
        'Il server ha risposto con un contenuto non JSON.');
    }

    if (res.ok) return payload;

    const error = (payload && payload.error) || {};
    throw new ApiError(res.status, error.code, error.message);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal && signal.aborted) throw new ApiError(0, 'ABORTED', 'Richiesta interrotta.');
    if (controller.signal.aborted) {
      throw new ApiError(0, 'TIMEOUT', 'Il server non ha risposto in tempo.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Server non raggiungibile.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', cancel);
  }
}

const enc = encodeURIComponent;

export const api = {
  /** Imposta il token usato nelle richieste successive. */
  setToken(value) {
    token = value;
  },

  // - utenti e sessioni -

  register(username, password) {
    return request('POST', '/users', { body: { username, password } });
  },

  async login(username, password) {
    const res = await request('POST', '/sessions', { body: { username, password } });
    token = res.token;
    return res;
  },

  async logout() {
    await request('DELETE', '/sessions/current');
    token = null;
  },

  whoami() {
    return request('GET', '/sessions/current');
  },

  // - stanze -

  listRooms(signal) {
    return request('GET', '/rooms', { signal });
  },

  createRoom(name, maxPlayers) {
    return request('POST', '/rooms', { body: { name, maxPlayers } });
  },

  getRoom(roomId, since, signal) {
    return request('GET', '/rooms/' + enc(roomId) + '?since=' + enc(since || '') + '&wait=1',
                   { timeoutMs: LONG_POLL_TIMEOUT_MS, signal });
  },

  joinRoom(roomId) {
    return request('POST', '/rooms/' + enc(roomId) + '/players', { body: {} });
  },

  leaveRoom(roomId, userId) {
    return request('DELETE', '/rooms/' + enc(roomId) + '/players/' + enc(userId));
  },

  deleteRoom(roomId) {
    return request('DELETE', '/rooms/' + enc(roomId));
  },

  startGame(roomId) {
    return request('POST', '/rooms/' + enc(roomId) + '/games', { body: {} });
  },

  // - partita -

  getGame(gameId, since, signal) {
    return request('GET', '/games/' + enc(gameId) + '?since=' + (since || 0) + '&wait=1',
                   { timeoutMs: LONG_POLL_TIMEOUT_MS, signal });
  },

  /**
   * Invia una mossa.
   * @param {string} gameId
   * @param {object} move { type, cardId?, cardIds?, chosenColor?, expectedVersion? }
   */
  sendMove(gameId, move) {
    return request('POST', '/games/' + enc(gameId) + '/moves', { body: move });
  }
};

//
// Token e utente stanno in sessionStorage: sopravvivono a un
// ricaricamento della pagina ma spariscono alla chiusura della scheda.
//

const STORAGE_KEY = 'uno.session';

function loadSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(token, user) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }));
  } catch {}
}

function clearSession() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// useSession

/**
 * Stato dell'autenticazione
 */
export function useSession() {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);

  useEffect(() => {
    let annullato = false;

    const saved = loadSession();
    if (!saved) {
      setStatus('anonymous');
      return undefined;
    }

    api.setToken(saved.token);
    api.whoami()
      .then((res) => {
        if (annullato) return;
        setUser(res.user);
        setStatus('authenticated');
      })
      .catch(() => {
        if (annullato) return;
        clearSession();
        api.setToken(null);
        setStatus('anonymous');
      });

    return () => { annullato = true; };
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await api.login(username, password);
    saveSession(res.token, res.user);
    setUser(res.user);
    setStatus('authenticated');
    return res.user;
  }, []);

  // Registrazione non autentica: subito dopo si effettua login
  const register = useCallback(async (username, password) => {
    await api.register(username, password);
    return login(username, password);
  }, [login]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignorato di proposito */ }
    clearSession();
    api.setToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  return { status, user, login, register, logout };
}

// useSync

export function isFinalError(err) {
  return !!err && [401, 403, 404, 410].includes(err.status);
}

const noVersion = () => undefined;
const never = () => false;

/**
 * Tiene aggiornato un dato del server con un ciclo di richieste
 *
 * @param {Function|null} load  null sospende la sincronizzazione
 * @param {object} [options]
 * @param {Function} [options.versionOf] dato -> versione da rimandare come `since`
 * @param {Function} [options.isDone]    dato -> true se non ci saranno novita'
 * @param {Function} [options.isOlder]   (nuovo, attuale) -> true se il nuovo dato
 *                                       e' piu' vecchio e va scartato
 * @param {number}   [options.delayMs]   pausa fra una richiesta e l'altra
 * @returns {{data, apply, error, setError}}
 */
export function useSync(load, { versionOf = noVersion, isDone = never, isOlder = never, delayMs = 0 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const apply = useCallback((next) => {
    setData((prev) => (prev && isOlder(next, prev) ? prev : next));
  }, [isOlder]);

  useEffect(() => {
    if (!load) return undefined;

    let attivo = true;
    let timer = null;
    const controller = new AbortController();
    const pausa = (ms) => new Promise((resolve) => { timer = setTimeout(resolve, ms); });

    async function loop() {
      let since;
      let retryDelay = 1000;

      while (attivo) {
        try {
          const next = await load(since, controller.signal);
          if (!attivo) return;

          retryDelay = 1000;
          setError(null);

          if (next !== null) {
            since = versionOf(next);
            apply(next);
            if (isDone(next)) return;
          }
          if (delayMs > 0) await pausa(delayMs);
        } catch (err) {
          if (!attivo || err.code === 'ABORTED') return;
          setError(err);
          if (isFinalError(err)) return;
          await pausa(retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15000);
        }
      }
    }

    loop();

    return () => {
      attivo = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, versionOf, isDone, delayMs, apply]);

  return { data, apply, error, setError };
}

// useRoomSync

const roomVersion = (room) => room.version;

/**
 * Sincronizzazione di una stanza con il long-polling
 *
 * @param {string|null} roomId
 * @param {boolean} [enabled] false sospende la sincronizzazione
 * @returns {{room: object|null, gone: Error|null}}
 */
export function useRoomSync(roomId, enabled = true) {
  const load = useCallback((since, signal) => api.getRoom(roomId, since, signal), [roomId]);
  const { data, error } = useSync(roomId && enabled ? load : null, { versionOf: roomVersion });
  return { room: data, gone: isFinalError(error) ? error : null };
}

// useGameSync

const gameVersion = (state) => state.version;
const gameOver = (state) => state.status !== 'playing';
const olderGame = (next, prev) => next.version < prev.version;

/**
 * Sincronizzazione dello stato della partita
 *
 * @param {string|null} gameId  null sospende la sincronizzazione
 */
export function useGameSync(gameId) {
  const load = useCallback((since, signal) => api.getGame(gameId, since, signal), [gameId]);
  const { data: state, apply, error, setError } = useSync(gameId ? load : null, {
    versionOf: gameVersion,
    isDone: gameOver,
    isOlder: olderGame
  });

  /**
   * Invia una mossa
   *
   * @returns {Promise<{ok: boolean, error?: Error}>}
   */
  const sendMove = useCallback(async (move) => {
    try {
      apply(await api.sendMove(gameId, { ...move, expectedVersion: state ? state.version : undefined }));
      return { ok: true };
    } catch (err) {
      if (isFinalError(err)) {
        setError(err);
      } else {
        try { apply(await api.getGame(gameId, 0)); } catch {}
      }
      return { ok: false, error: err };
    }
  }, [gameId, state, apply, setError]);

  return { state, error, sendMove };
}
