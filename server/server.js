'use strict';

/**
 * Punto di ingresso del server
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('./db');
const { router: api, requestLogger, notFound, errorHandler, optionalAuth } = require('./api');
const roomService = require('./rooms');

const { config, userRepository } = db;

const app = express();

// middleware globali

app.use(express.json({ limit: '32kb' }));

app.use(optionalAuth);
app.use(requestLogger);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// API

app.use('/api', api);

// client statico

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

if (!fs.existsSync(CLIENT_DIST)) {
  console.warn(
    '\nATTENZIONE: client/dist non esiste: il client non verra\' servito.\n' +
    '            Compilalo con "npm run client:build".\n' +
    "            L'API su /api resta comunque disponibile.\n"
  );
}

app.use(express.static(CLIENT_DIST, {
  maxAge: config.env === 'production' ? '1y' : 0,
  index: false
}));

app.get(/^\/(?!api(\/|$)).*/, (req, res, next) => {
  const indexFile = path.join(CLIENT_DIST, 'index.html');
  if (!fs.existsSync(indexFile)) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(indexFile);
});

// errori

app.use(notFound);
app.use(errorHandler);

// avvio

async function start() {
  for (const w of config.warnings) console.warn(`ATTENZIONE: ${w}`);

  const health = await db.healthCheck();
  if (!health.ok) {
    console.error('\n' + health.message + '\n');
    console.error('Il server si avvia comunque: GET /api/health, che non tocca');
    console.error('le tabelle, resta disponibile.\n');
  } else {
    console.log(health.message);
  }

  const server = app.listen(config.http.port, config.http.host, () => {
    console.log('========== UNO Online ==========');
    console.log(`  client   http://${config.http.host}:${config.http.port}/`);
    console.log(`  API      http://${config.http.host}:${config.http.port}/api`);
    console.log(`  ambiente ${config.env}`);
    console.log('================================');
  });

  server.headersTimeout = config.sync.longPollTimeoutMs + 10000;
  server.requestTimeout = config.sync.longPollTimeoutMs + 10000;
  server.keepAliveTimeout = config.sync.longPollTimeoutMs + 5000;

  // Pulizia periodica delle sessioni scadute.
  const cleanup = setInterval(() => {
    userRepository.purgeExpiredSessions().catch((e) =>
      console.error('Pulizia sessioni fallita:', e.message));
  }, 15 * 60 * 1000);
  cleanup.unref();

  // Controllo periodico di chi e' collegato alle stanze
  let sweeping = false;
  let lastSweepError = null;
  const sweeper = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const { roomsClosed, guestsRemoved } = await roomService.handleDisconnections();
      if (roomsClosed > 0) console.log(`Stanze eliminate per proprietario disconnesso: ${roomsClosed}`);
      if (guestsRemoved > 0) console.log(`Ospiti usciti per disconnessione: ${guestsRemoved}`);
      lastSweepError = null;
    } catch (e) {
      if (e.message !== lastSweepError) console.error('Controllo delle stanze fallito:', e.message);
      lastSweepError = e.message;
    } finally {
      sweeping = false;
    }
  }, config.rooms.sweepIntervalMs);
  sweeper.unref();

  const shutdown = async (signal) => {
    console.log(`\n${signal}: arresto in corso...`);
    server.close(async () => {
      await db.close();
      console.log('Arresto completato.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Avvio fallito:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
