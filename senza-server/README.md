# webrtc-test — versione "senza server"

Controlla un gioco Godot dal telefono, usando il telefono come controller via
WebRTC DataChannel, **senza che telefono e PC siano sulla stessa rete** e
**senza nessun server di terze parti** (niente ntfy.sh, niente GitHub Pages:
il gioco serve tutto da sé).

Per la versione precedente, più semplice ma che dipende da ntfy.sh per il
signaling, vedi [`../con-server/`](../con-server/).

Il progetto è pensato anche come **banco di prova per la latenza**: sia l'host
che il controller mostrano statistiche round-trip in tempo reale, e uno script
Node.js (in [`../tests/`](../tests/)) simula N controller che inondano l'host
di input per osservarne il comportamento sotto carico.

## Architettura

- **Gioco** (`godot/`): progetto Godot 4.7, eseguito come app desktop. Fa da
  host ed è l'**unico** pezzo di infrastruttura del prototipo:
  - serve lui stesso la pagina del controller web (`godot/web/`) via HTTP;
  - accetta il signaling WebRTC (offer/answer/candidate) via WebSocket, una
    connessione dedicata per telefono;
  - usa `UPNP` (classe core di Godot, nessun addon) per mappare le sue due
    porte sul router e farsi raggiungere da internet, non solo dalla LAN.
  - mostra QR code + URL per collegarsi, e un pannello con le statistiche di
    latenza/throughput di ogni controller connesso.
- **Controller** (`godot/web/`): pagina HTML + JS vanilla, servita dal gioco
  stesso (non più ospitata altrove). Nessun framework, nessun build step.
  Joystick virtuale a 360° per il movimento, 8 tasti per misurare la latenza,
  pannello con numero corrente + statistiche + sparkline.
- **Signaling**: WebSocket diretto, 1 connessione per telefono, servito dal
  gioco (vedi `godot/local_server.gd`). Isolato dal resto con la stessa
  interfaccia minima di prima: `send(msg)` per pubblicare, `on_message(msg)`
  per ricevere (vedi anche `godot/web/signaling.js`) - sostituibile con un
  altro trasporto senza toccare il resto.
- **Trasporto di gioco**: WebRTC DataChannel peer-to-peer, telefono <-> gioco.
  Solo STUN pubblico (`stun:stun.l.google.com:19302`), **nessun TURN**.
- **Load test** (`../tests/load_test.js --mode local`): script Node.js che
  simula N controller via [node-datachannel](https://github.com/murat-dogan/node-datachannel)
  (lo stesso libdatachannel usato lato Godot) per studiare latenza e
  throughput sotto carico.

## Perché non serve (e non si può evitare del tutto) un server

WebRTC richiede sempre uno scambio *bidirezionale* di offer/answer prima che
la connessione diretta possa aprirsi: qualcuno deve portare la risposta del
telefono fino al PC. Senza un relay di terze parti e senza LAN condivisa,
l'unico modo è che **il PC stesso sia raggiungibile da internet** - è
esattamente a questo che serve UPnP: il gioco apre due porte TCP locali (una
per servire la pagina del controller via HTTP, una per il signaling via
WebSocket - le API di Godot non permettono di condividerle) e chiede al router
di mapparle verso l'esterno. Il QR code incorpora l'IP pubblico/porta così
ottenuti.

Questo significa che **il server esiste comunque**, ma è "tuo": gira dentro al
gioco stesso sulla tua macchina, non su un'infrastruttura di terzi. Se il
router non supporta UPnP (disattivato di default su alcuni modelli, quasi
sempre bloccato su reti aziendali o dietro CGNAT), il gioco ricade sull'IP
della LAN: funziona comunque se telefono e PC sono sulla stessa rete, ma non
oltre. Il pannello di rete nell'host dice sempre quale dei due casi si è
verificato.

## Come avviare

1. Apri `godot/` in Godot 4.7+ (o esegui `godot --path godot`).
2. Premi Play (o esegui `godot --path godot` da terminale: l'URL viene anche
   stampato in console). Il gioco apre le porte locali, prova UPnP, e mostra
   un QR code + l'URL in chiaro (es. `http://1.2.3.4:38214/?wsport=38215`).
   Il pannello sopra l'URL dice se UPnP ha funzionato (IP pubblico) o se si è
   ricaduti sulla LAN.
3. Dal telefono, scansiona il QR code (o apri l'URL a mano). Si apre la pagina
   controller: joystick a sinistra, 8 tasti numerati a destra, pannello di
   latenza in alto.
4. Trascina il joystick: l'omino corrispondente sul gioco si muove a 360° nella
   direzione del joystick e ruota per guardarci. Premi i tasti numerati per
   misurare la latenza (ogni pressione spara un ping indipendente).

Ogni telefono che si collega ottiene una `WebRTCPeerConnection` dedicata e un
omino tutto suo. Il pannello statistiche dell'host (sotto il QR) mostra, per
ogni controller connesso: latenza corrente/media/min/max, jitter, perdita di
ping, e messaggi "move" al secondo in ingresso.

## Come testare la connessione "cross-network"

Per verificare che funzioni davvero senza rete condivisa (richiede che UPnP
abbia funzionato - controlla il pannello di rete):
- Lascia il PC sulla tua Wi-Fi di casa.
- Collega il telefono ai dati mobili (4G/5G), **non** alla stessa Wi-Fi.
- Scansiona il QR code e verifica che l'omino si muova.

Se il telefono è anche lui dietro un NAT severo o CGNAT lato 4G, la connessione
WebRTC può non stabilirsi (vedi limiti noti sotto): in quel caso provalo da
un'altra rete Wi-Fi diversa da quella del PC.

## Protocollo di signaling

Ogni telefono apre una propria connessione WebSocket verso `ws_port` (vedi
`godot/local_server.gd`): essendo 1:1, non serve più instradare niente con
`from`/`to`, il canale stesso identifica il peer. Messaggi JSON:

- `offer` / `answer` — scambio SDP (campo `sdp`).
- `candidate` — scambio ICE candidate (campi `media`, `index`, `candidate`).

Flusso: appena il WebSocket si apre, l'host crea la `WebRTCPeerConnection` e
manda `offer` -> il telefono risponde `answer` -> entrambi si scambiano i
`candidate` non appena li scoprono (trickle ICE). Non serve più un messaggio
di "hello": la connessione WebSocket stessa è il segnale che un telefono è
arrivato.

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
- **Load test** (`../tests/load_test.js --mode local`): simula N controller
  che si collegano allo stesso host e lo inondano di messaggi "move", per
  osservare come latenza e perdita del pannello host cambiano sotto carico.

```bash
cd ../tests
npm install
node load_test.js --mode local --ip <IP_MOSTRATO_DALL_HOST> --wsport <PORTA_WS> --clients 10 --rate 30 --duration 20
```

IP e porta sono quelli nell'URL mostrato dall'host (es.
`http://1.2.3.4:38214/?wsport=38215` -> `--ip 1.2.3.4 --wsport 38215`).
Altri argomenti: `--clients` (numero di controller simulati, default 5),
`--rate` (messaggi "move" al secondo per client, default 30), `--duration`
(secondi di flood, default 20), `--stagger` (ritardo in ms tra l'avvio di un
client e il successivo, default 50). A differenza della versione "con server"
([`../con-server/`](../con-server/)) basata su ntfy.sh, qui ogni client apre
una propria connessione diretta: non c'è più un relay condiviso con un limite
di burst da rispettare durante l'handshake - il collo di bottiglia, se c'è, è
solo quanti handshake l'host riesce a gestire in parallelo.

Lo script usa [node-datachannel](https://github.com/murat-dogan/node-datachannel)
via la sua API `RTCPeerConnection` standard (polyfill), con lo stesso protocollo
di signaling e lo stesso schema dei messaggi del controller web: l'host li
tratta come controller qualsiasi, senza bisogno di codice separato.

## Limiti noti

- **UPnP non è garantito**: alcuni router lo hanno disattivato di default, le
  reti aziendali e la maggior parte delle connessioni dietro CGNAT lo bloccano
  del tutto. In quel caso il gioco ricade sulla LAN (vedi sopra) e telefono e
  PC devono essere sulla stessa rete per connettersi - l'esatto scenario che
  si voleva evitare, ma è l'unico fallback sensato senza un relay esterno.
- **Niente TURN**: anche con UPnP funzionante, alcune reti (in particolare
  4G/5G dietro CGNAT lato telefono, o NAT molto restrittivo) possono impedire
  la connessione diretta peer-to-peer per il *DataChannel* stesso (questo è
  indipendente dal signaling). Con un TURN relay funzionerebbe sempre, ma è
  fuori scope per questo prototipo.
- **Nessun firewall/port-forwarding manuale previsto**: se UPnP fallisce e non
  si vuole restare sulla LAN, l'alternativa è aprire manualmente le porte
  `38214` e `38215` (TCP) sul router - il gioco non lo fa per te.
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
- **UPnP non verificato su un router reale** durante lo sviluppo di questo
  prototipo (l'ambiente usato per i test non aveva un gateway UPnP
  raggiungibile): la logica di `discover()`/`add_port_mapping()` è quella
  documentata e verificata solo fino a quel punto, il fallback alla LAN è
  invece verificato end-to-end. Testala sulla tua rete reale prima di
  fidartene per una connessione cross-network.

## Licenze di terze parti incluse

- `godot/addons/webrtc_native/`: [godotengine/webrtc-native](https://github.com/godotengine/webrtc-native)
  (MIT + licenze permissive delle dipendenze, vedi i file `LICENSE.*` nella cartella).
- `godot/addons/qrcode/`: generatore QR code vendorizzato da
  [Greaby/godot-qrcode-generator](https://github.com/Greaby/godot-qrcode-generator) (MIT).

Il load test in [`../tests/`](../tests/) dipende da
[node-datachannel](https://github.com/murat-dogan/node-datachannel) (MPL 2.0),
installato via `npm install`, non vendorizzato nel repo.
