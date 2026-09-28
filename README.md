# UNO multiplayer
Progetto Tecnologie Internet - Camilla Dembowski

Piattaforma web multiplayer per giocare a UNO.

## 1. Presentazione:
Permette a più utenti registrati di ritrovarsi in una lobby, creare o entrare in una stanza e giocare una partita a UNO.

Il sistema ha un'architettura client/server: un client React comunica con un server Node.js tramite API REST in JSON. Lo stato è salvato su un database MySQL.

## 2. Avvio del progetto:
```sh
# installare le dipendenze di server e client e compilare il client React
npm run setup

# creare database e tabelle
npm run db:init

# avviare il server (client e API su http://127.0.0.1:5678/)
npm start
```

Per provare una partita servono almeno due giocatori: basta aprire una nuova scheda del browser, digitare l'indirizzo e accedere con un altro account.

## 3. Funzionalità:
**Utenti e sessioni**
- registrazione con nome utente univoco (3–32 caratteri) e password di almeno 8 caratteri;
- login con rilascio di un token di sessione a scadenza, e logout che lo invalida sul server.

**Stanze**
- creazione di una stanza (2–6 giocatori) ed elenco delle stanze aperte, aggiornato automaticamente;
- ingresso in una stanza non piena;
- sala d'attesa sincronizzata in tempo reale;
- il proprietario avvia la partita (almeno 2 giocatori), può rimuovere gli altri partecipanti ed eliminare la stanza;
- gestione delle disconnessioni: se il proprietario non si fa vivo per 20 s la stanza viene eliminata; se è un ospite a disconnettersi esce dalla stanza e dalla partita;
- a fine partita la stanza torna aperta e si può rigiocare con gli stessi partecipanti.

**Partita**
- mazzo di 108 carte, come da regole ufficiali;
- inizio partita con 7 carte a testa
- regole ufficiali di giocabilità (colore, numero o simbolo, jolly sempre giocabili);
- effetti delle carte speciali (cambio giro, salta il turno, pesca +2, jolly cambio colore, jolly pesca +4) applicati dal server;
- varianti rispetto alle regole ufficiali:
    - accumulo dei pesca +2 o +4,
    - giocata multipla di carte con lo stesso numero o simbolo, con effetti che si sommano;
- segnalazione automatica *UNO!* a chi resta con una carta;
- fine partita quando un giocatore esaurisce la mano, con punteggio pari alla somma delle carte rimaste agli avversari;
- ogni mossa illegale è rifiutata con un codice d'errore e non altera lo stato.

**Interfaccia**
- mano del giocatore con carte giocabili evidenziate;
- numero di carte degli avversari;
- carta in cima e colore attivo;
- senso di gioco e turno corrente;
- pesca accumulata;
- registro degli eventi della partita.

## 4. Struttura del progetto:
```
uno-online/
 ┣━━ server/
 ┃     ┣━ server.js          avvio, middleware globali, header di sicurezza, file statici
 ┃     ┣━ api.js             autenticazione, gestione degli errori, rotte REST
 ┃     ┣━ rooms.js           notifiche del long-polling, presenza, ciclo di vita delle stanze
 ┃     ┣━ db.js              configurazione, crittografia, pool MySQL e repository
 ┃     ┗━ game.js            motore di gioco: mazzo, regole, macchina a stati, vista per giocatore
 ┣━━ client/                 applicazione React (Vite)
 ┃     ┣━ index.html
 ┃     ┣━ vite.config.js     build e proxy verso l'API in sviluppo
 ┃     ┗━ src/
 ┃          ┣━ main.jsx      componente App e scelta della vista
 ┃          ┣━ hooks.js      client HTTP e hook useSession, useSync, useRoomSync, useGameSync
 ┃          ┣━ Views.jsx     accesso, lobby, sala d'attesa
 ┃          ┣━ GameView.jsx  tavolo di gioco
 ┃          ┗━ style.css     stile dell'interfaccia e delle carte
 ┣━━ db/schema.sql           schema del database
 ┗━━ scripts/init-db.js      inizializzazione del database
```

## 5. Tecnologie utilizzate:
- **JavaScript**
- **HTML** — pagina contenitore (`client/index.html`) in cui React monta l'applicazione.
- **CSS** — stile di tutta l'interfaccia e disegno delle carte.
- **React** — interfaccia a componenti: le quattro viste (accesso, lobby, sala d'attesa, tavolo) e gli hook che tengono sincronizzati i dati con il server.
- **Vite** — compila il client in `client/dist/`.
- **Node.js** — ambiente di esecuzione del server: ospita API, motore di gioco e long-polling.
- **MySQL** — database: conserva utenti, sessioni, stanze, partecipanti e partite; lo stato di ogni partita è salvato in una colonna JSON.
- **JSON** — formato di scambio tra client e server e formato di salvataggio dello stato della partita.

## 6. Struttura database:
<img width="777" height="537" alt="image" src="https://github.com/user-attachments/assets/4b6efdbb-99fe-49c2-a5ba-d449aedea22f" />

