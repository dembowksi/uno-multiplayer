'use strict';

/**
 * Crea il database e le tabelle a partire da db/schema.sql.
 *
 *   npm run db:init
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { config } = require('../server/db');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log(`Connessione a ${config.db.user}@${config.db.host}:${config.db.port} ...`);

  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    // necessario per eseguire l'intero file in una volta
    multipleStatements: true
  });

  try {
    await connection.query(sql);
    console.log(`Schema applicato sul database "${config.db.database}".`);

    const [tables] = await connection.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [config.db.database]
    );
    console.log('Tabelle presenti: ' + tables.map((t) => t.TABLE_NAME).join(', '));
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error('\nInizializzazione fallita:', err.message);
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Le credenziali in .env non sono valide, oppure l\'utente non ha');
    console.error('il permesso di creare database. Prova con un utente amministrativo:');
    console.error('  mysql -u root -p < db/schema.sql');
  }
  if (err.code === 'ECONNREFUSED') {
    console.error('MySQL non risponde: controlla che il servizio sia avviato.');
  }
  process.exit(1);
});
