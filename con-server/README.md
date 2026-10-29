# con-server

Controller da telefono via WebRTC. Signaling tramite ntfy.sh (pub/sub pubblico gratuito).

## Avvio

Il contenuto di `web/` è già pubblicato via GitHub Pages: una copia vive in
`/docs` nella root del repo (unico path che l'API di Pages accetta oltre a
`/`), abilitata con:

```
gh api -X POST repos/chirichexe/webrtc-test/pages -f "source[branch]=main" -f "source[path]=/docs"
```

È già raggiungibile su `https://chirichexe.github.io/webrtc-test/`, già impostato
come `PAGES_BASE_URL` in `godot/main.gd`. Se modifichi `web/`, ricordati di
copiare i file anche in `/docs` e pushare.

Avvia il gioco:

```
godot --path godot
```

Premi Play (o avvialo da terminale, il codice stanza e l'URL vengono stampati in console). Scansiona il QR mostrato dal gioco con il telefono.

## Test (load test)

```
cd ../tests
npm install
node load_test.js --mode server --room CODICE --clients 10 --rate 30 --duration 20
```

`CODICE` è quello mostrato dall'host. Altri argomenti: `--clients`, `--rate`, `--duration`, `--stagger` (default 150ms, ntfy ha un rate limit per-IP).

## Protocollo

Topic ntfy: `gdwebrtc-ctrl-<CODICE>`. Messaggi `{from, to, type}`: `hello`, `offer`/`answer` (campo `sdp`), `candidate` (campi `media`, `index`, `candidate`).

Sul DataChannel: `{"type":"move","x":..,"y":..}`, `{"type":"ping","id":N}`, `{"type":"pong","id":N}`.

## Limiti

- Niente TURN: alcune reti con NAT severo non si connettono.
- ntfy.sh è condiviso e limitato per IP (250 msg/giorno, burst 60): con molti client del load test sulla stessa macchina dell'host il burst si esaurisce in fretta, per questo c'è retry automatico sui 429 e `--stagger`.
- Una volta connessi, il traffico di gioco è peer-to-peer e non passa più da ntfy.
- Crash raro in chiusura su Linux (race condition nota di libdatachannel), innocuo.
- Solo binari Linux x86_64 per `webrtc_native` inclusi nel repo.
- Nessuna riconnessione automatica se il WebSocket di signaling cade.
