# senza-server

Controller da telefono via WebRTC. Nessun servizio esterno: il gioco serve lui stesso la pagina del controller e il signaling, e usa UPnP per farsi raggiungere da internet.

## Avvio

```
godot --path godot
```

Premi Play (o avvialo da terminale, l'URL viene stampato in console). Il gioco apre due porte locali, prova UPnP, mostra un QR + URL (es. `http://1.2.3.4:38214/?wsport=38215`) e un pannello che dice se UPnP ha funzionato (IP pubblico) o se è ricaduto sulla LAN. Scansiona il QR dal telefono.

Se il pannello dice "solo LAN", il telefono deve stare sulla stessa rete del PC.

## Test (load test)

```
cd ../tests
npm install
node load_test.js --mode local --ip IP --wsport PORTA --clients 10 --rate 30 --duration 20
```

IP e porta sono quelli nell'URL mostrato dall'host. Altri argomenti: `--clients`, `--rate`, `--duration`, `--stagger` (default 50ms, qui non c'è un relay condiviso quindi non serve un valore alto).

## Protocollo

Una connessione WebSocket dedicata per telefono (niente topic condiviso, niente `from`/`to`). Messaggi: `offer`/`answer` (campo `sdp`), `candidate` (campi `media`, `index`, `candidate`).

Sul DataChannel: `{"type":"move","x":..,"y":..}`, `{"type":"ping","id":N}`, `{"type":"pong","id":N}`.

## Limiti

- UPnP non è garantito: router con UPnP disattivato, reti aziendali e CGNAT lo bloccano. In quel caso serve la stessa LAN.
- Niente TURN: anche con UPnP, alcune reti con NAT severo sul telefono non si connettono.
- Nessun port-forwarding manuale automatico: se UPnP fallisce, le porte `38214`/`38215` vanno aperte a mano sul router, se non si vuole restare sulla LAN.
- Crash raro in chiusura su Linux (race condition nota di libdatachannel), innocuo.
- Solo binari Linux x86_64 per `webrtc_native` inclusi nel repo.
- Nessuna riconnessione automatica se il WebSocket di signaling cade.
- UPnP non testato su un router reale durante lo sviluppo (nessun gateway raggiungibile nell'ambiente di test): verificalo sulla tua rete prima di fidartene.
