# webrtc-test — versione "con server"

Controlla un gioco Godot dal telefono, usando il telefono come controller via
WebRTC DataChannel, **senza che telefono e PC siano sulla stessa rete**. Il
signaling (lo scambio iniziale di offer/answer/candidate) passa da
[ntfy.sh](https://ntfy.sh), un servizio pub/sub pubblico e gratuito: è il
"server" del nome di questa cartella, anche se non è un server scritto da noi.

Per la versione che non dipende da nessun servizio di terze parti (incluso
ntfy.sh), vedi [`../senza-server/`](../senza-server/).

Il progetto è pensato anche come **banco di prova per la latenza**: sia l'host
che il controller mostrano statistiche round-trip in tempo reale, e uno script
Node.js (in [`../tests/`](../tests/)) simula N controller che inondano l'host
di input per osservarne il comportamento sotto carico.

## Architettura

- **Gioco** (`godot/`): progetto Godot 4.7, eseguito come app desktop. Fa da host,
  genera un codice stanza, mostra un QR code da scansionare e un pannello con le
  statistiche di latenza/throughput di ogni controller connesso.
- **Controller** (`web/`): pagina statica HTML + JS vanilla, da pubblicare su
  un hosting statico qualsiasi (GitHub Pages, Netlify, ...). Nessun framework,
  nessun build step. Joystick virtuale a 360° per il movimento, 8 tasti per
  misurare la latenza, pannello con numero corrente + statistiche + sparkline.
- **Signaling**: ntfy.sh. Si pubblica via HTTP POST e si legge via WebSocket su
  un topic condiviso. Isolato in `godot/signaling.gd` e `web/signaling.js`,
  entrambi con la stessa interfaccia minima: `send(msg)` per pubblicare,
  `on_message(msg)` per ricevere. Sostituibile con un altro trasporto senza
  toccare il resto.
- **Trasporto di gioco**: WebRTC DataChannel peer-to-peer, telefono <-> gioco.
  Solo STUN pubblico (`stun:stun.l.google.com:19302`), **nessun TURN**.

## Come avviare

1. Pubblica il contenuto di `web/` su un hosting statico HTTPS qualsiasi. Con
   GitHub Pages: crea un repo pubblico, pusha il contenuto di `web/` in una
   cartella `docs/` nella root del repo (è il solo path, insieme a `/`, che la
   UI di GitHub Pages permette di scegliere), poi abilita Pages su quella
   cartella (`gh api -X POST repos/<utente>/<repo>/pages -f "source[branch]=main" -f "source[path]=/docs"`).
2. Aggiorna `PAGES_BASE_URL` in `godot/main.gd` con l'URL risultante.
3. Apri `godot/` in Godot 4.7+ (o esegui `godot --path godot`). Premi Play (o
   esegui da terminale: il codice stanza viene anche stampato in console). Il
   gioco genera un codice stanza casuale, apre la subscription ntfy e mostra
   un QR code + l'URL in chiaro (`<PAGES_BASE_URL>?room=CODICE`).
4. Dal telefono, scansiona il QR code (o apri l'URL a mano). Si apre la pagina
   controller: joystick a sinistra, 8 tasti numerati a destra, pannello di
   latenza in alto.
5. Trascina il joystick: l'omino corrispondente sul gioco si muove a 360° nella
   direzione del joystick e ruota per guardarci. Premi i tasti numerati per
   misurare la latenza (ogni pressione spara un ping indipendente).

Ogni telefono che si collega ottiene una `WebRTCPeerConnection` dedicata e un
omino tutto suo. Il pannello statistiche dell'host (sotto il QR) mostra, per
ogni controller connesso: latenza corrente/media/min/max, jitter, perdita di
ping, e messaggi "move" al secondo in ingresso.

## Come testare la connessione "cross-network"

Per verificare che funzioni davvero senza rete condivisa:
- Lascia il PC sulla tua Wi-Fi di casa.
- Collega il telefono ai dati mobili (4G/5G), **non** alla stessa Wi-Fi.
- Scansiona il QR code e verifica che l'omino si muova.

Se il telefono è anche lui dietro un NAT severo o CGNAT lato 4G, la connessione
WebRTC può non stabilirsi (vedi limiti noti sotto): in quel caso provalo da
un'altra rete Wi-Fi diversa da quella del PC.

## Protocollo di signaling

Topic ntfy: `gdwebrtc-ctrl-<CODICE>` (6 caratteri alfanumerici casuali).

Messaggi JSON pubblicati sul topic, tutti con `{from, to, type}`:

- `hello` — il telefono si annuncia all'host (`to: "host"`).
- `offer` / `answer` — scambio SDP (campo `sdp`).
- `candidate` — scambio ICE candidate (campi `media`, `index`, `candidate`).

Flusso: il telefono manda `hello` -> l'host crea la `WebRTCPeerConnection` e
manda `offer` -> il telefono risponde `answer` -> entrambi si scambiano i
`candidate` non appena li scoprono (trickle ICE). Ogni lato ignora i messaggi
non indirizzati al proprio id (`to` diverso dal proprio).

Sul DataChannel (`label: "input"`, negoziato, `id: 1`, `ordered: false`,
`maxRetransmits: 0`) viaggiano messaggi JSON taggati con `type`:

- `{"type":"move","x":-1..1,"y":-1..1}` — vettore dal joystick, inviato ~30
  volte al secondo mentre è attivo, e una volta con `{0,0}` al rilascio.
- `{"type":"ping","id":N}` — probe di latenza, in entrambe le direzioni.
- `{"type":"pong","id":N}` — risposta immediata a un `ping` con lo stesso `id`.

Ogni lato, appena riceve un `ping`, risponde subito con un `pong`: l'host lo usa
per misurare la latenza verso ogni controller (incluso quelli del load test, che
non premono mai i tasti ma rispondono comunque ai ping), il controller lo usa
quando l'utente preme uno dei tasti numerati.

## Studio della latenza

- **Controller**: pannello in alto con il numero (ms) dell'ultimo ping, media/
  min/max/jitter/perdita, e una sparkline con la cronologia.
- **Host**: pannello scorrevole sotto il QR con una riga per ogni controller
  connesso, stessa metrica più i messaggi "move" al secondo in ingresso (utile
  per vedere l'effetto del load test).
- **Load test** (`../tests/load_test.js --mode server`): simula N controller
  che si collegano allo stesso host e lo inondano di messaggi "move", per
  osservare come latenza e perdita del pannello host cambiano sotto carico.

```bash
cd ../tests
npm install
node load_test.js --mode server --room CODICE --clients 10 --rate 30 --duration 20
```

Argomenti: `--room` (obbligatorio, il codice mostrato dall'host), `--clients`
(numero di controller simulati, default 5), `--rate` (messaggi "move" al
secondo per client, default 30), `--duration` (secondi di flood, default 20),
`--stagger` (ritardo in ms tra l'avvio di un client e il successivo, default
150 per questa modalità — vedi il limite di ntfy sotto).

## Limiti noti

- **Niente TURN**: alcune reti (in particolare 4G/5G dietro CGNAT, o reti
  aziendali con NAT molto restrittivo) possono impedire la connessione diretta
  peer-to-peer. Con un TURN relay funzionerebbe sempre, ma è fuori scope per
  questo prototipo.
- **ntfy.sh è un servizio pubblico condiviso, limitato per IP**: il nome del
  topic funziona da "password" implicita, e l'account anonimo ha un limite di
  250 messaggi/giorno e un burst di 60 richieste (poi 1 ogni 5s), **per IP
  pubblico**, non per connessione singola. Ogni handshake telefono<->host usa
  circa 10-15 messaggi di signaling: va benissimo per un controller reale, ma
  **con il load test, host e client simulati sulla stessa macchina condividono
  lo stesso IP** — con molti `--clients` il burst si esaurisce rapidamente (a
  quota esaurita ntfy risponde `429` e i messaggi di signaling vengono persi).
  Per questo:
  - tutte le implementazioni del signaling (`signaling.gd`, `signaling.js`,
    quella dentro `load_test.js`) ritentano automaticamente con backoff
    crescente sui `429`, invece di perdere il messaggio in silenzio;
  - con tanti `--clients` aumenta `--stagger` per spalmare gli handshake nel
    tempo;
  - una volta stabilita la connessione il traffico "move"/"ping"/"pong" è
    peer-to-peer e **non passa più da ntfy**: il flood vero e proprio non è
    limitato da questo, solo la fase di handshake iniziale lo è.
- **Crash raro in uscita su Linux**: l'estensione nativa `webrtc_native`
  (basata su libdatachannel) ha una race condition nota e rara alla chiusura
  del processo (thread di cleanup ancora attivo quando la libreria viene
  scaricata) — innocua, capita a volte in chiusura, non durante il gioco.
- Solo i binari Linux x86_64 dell'estensione `webrtc_native` sono inclusi nel
  repo (per tenerlo leggero); per Windows/macOS/altre architetture scarica gli
  altri file da [godotengine/webrtc-native releases](https://github.com/godotengine/webrtc-native/releases)
  e aggiungili in `godot/addons/webrtc_native/lib/`.
- Nessuna riconnessione automatica: se il WebSocket di signaling si disconnette
  o la pagina viene ricaricata, bisogna far ripartire il flusso (richiudere e
  riaprire la pagina controller).
- `node-datachannel` (usato dal load test) non popola `sdpMLineIndex` nei suoi
  ICE candidate (resta sempre `null`); con un solo DataChannel non è un
  problema (l'indice è comunque sempre 0), ma è il motivo per cui
  `load_test.js` forza `index: 0` quando manca, e `main.gd` normalizza un
  eventuale `null` prima di convertirlo a intero (altrimenti GDScript va in
  errore su `int(null)`).

## Licenze di terze parti incluse

- `godot/addons/webrtc_native/`: [godotengine/webrtc-native](https://github.com/godotengine/webrtc-native)
  (MIT + licenze permissive delle dipendenze, vedi i file `LICENSE.*` nella cartella).
- `godot/addons/qrcode/`: generatore QR code vendorizzato da
  [Greaby/godot-qrcode-generator](https://github.com/Greaby/godot-qrcode-generator) (MIT).

Il load test in [`../tests/`](../tests/) dipende da
[node-datachannel](https://github.com/murat-dogan/node-datachannel) (MPL 2.0),
installato via `npm install`, non vendorizzato nel repo.
