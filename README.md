# webrtc-test

Prototipo minimo: controlla un gioco Godot dal telefono, usando il telefono come
controller via WebRTC DataChannel, **senza che telefono e PC siano sulla stessa
rete** e **senza un server nostro**. Nessuno stile o UI curata: l'obiettivo è solo
che il protocollo e la connessione funzionino.

## Architettura

- **Gioco** (`godot/`): progetto Godot 4.7, eseguito come app desktop. Fa da host,
  genera un codice stanza e mostra un QR code da scansionare.
- **Controller** (`docs/`): pagina statica HTML + JS vanilla, pubblicata su
  GitHub Pages. Nessun framework, nessun build step.
- **Signaling**: [ntfy.sh](https://ntfy.sh), un servizio pub/sub pubblico gratuito.
  Niente server nostro: si pubblica via HTTP POST e si legge via WebSocket su un
  topic condiviso. Isolato in `godot/signaling.gd` e `docs/signaling.js`, entrambi
  con la stessa interfaccia minima: `send(msg)` per pubblicare, `on_message(msg)`
  per ricevere. Sostituibile con un altro trasporto senza toccare il resto.
- **Trasporto di gioco**: WebRTC DataChannel peer-to-peer, telefono <-> gioco.
  Solo STUN pubblico (`stun:stun.l.google.com:19302`), **nessun TURN**.

## Come avviare

1. Apri `godot/` in Godot 4.7+ (o esegui `godot --path godot`).
2. Premi Play. Il gioco genera un codice stanza casuale, apre la subscription
   ntfy e mostra un QR code + l'URL in chiaro (`https://chirichexe.github.io/webrtc-test/?room=CODICE`).
3. Dal telefono, scansiona il QR code (o apri l'URL a mano). Si apre la pagina
   controller con 4 freccette.
4. Tieni premuta una freccetta: il quadrato colorato corrispondente sul gioco si
   muove nella direzione corrispondente.

Ogni telefono che si collega ottiene una `WebRTCPeerConnection` dedicata e un
quadrato colorato tutto suo.

## Come testare la connessione "cross-network"

Per verificare che funzioni davvero senza rete condivisa:
- Lascia il PC sulla tua Wi-Fi di casa.
- Collega il telefono ai dati mobili (4G/5G), **non** alla stessa Wi-Fi.
- Scansiona il QR code e verifica che il quadrato si muova.

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
`maxRetransmits: 0`) viaggia solo `{"x": -1..1, "y": -1..1}`: inviato ~30
volte al secondo mentre un tasto è premuto, e una volta con `{0,0}` al
rilascio.

## Limiti noti

- **Niente TURN**: alcune reti (in particolare 4G/5G dietro CGNAT, o reti
  aziendali con NAT molto restrittivo) possono impedire la connessione diretta
  peer-to-peer. Con un TURN relay funzionerebbe sempre, ma è fuori scope per
  questo prototipo.
- **ntfy.sh è un servizio pubblico condiviso**: il nome del topic funziona da
  "password" implicita (chi lo conosce può inserirsi nella sessione), e
  l'account anonimo su ntfy.sh ha un limite di 250 messaggi/giorno per IP e un
  burst di 60 richieste (poi 1 ogni 5s). Ogni connessione telefono<->host usa
  circa 10-15 messaggi di signaling, quindi va bene per testare ma non per uso
  intensivo.
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

## Licenze di terze parti incluse

- `godot/addons/webrtc_native/`: [godotengine/webrtc-native](https://github.com/godotengine/webrtc-native)
  (MIT + licenze permissive delle dipendenze, vedi i file `LICENSE.*` nella cartella).
- `godot/addons/qrcode/`: generatore QR code vendorizzato da
  [Greaby/godot-qrcode-generator](https://github.com/Greaby/godot-qrcode-generator) (MIT).
