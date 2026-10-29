#!/usr/bin/env node
// Stress test: simula N controller che si collegano allo stesso host Godot
// e inondano il DataChannel di messaggi "move", per vedere come l'host
// (vedi */godot/main.gd, pannello statistiche) reagisce sotto carico.
// Funziona contro ENTRAMBE le versioni del progetto, scelta con --mode:
//
//   --mode server   -> con-server/ (signaling via ntfy.sh, instradato con
//                       from/to su un topic condiviso, serve --room)
//   --mode local    -> senza-server/ (signaling via WebSocket diretto
//                       1:1 servito dall'host stesso, servono --ip e --wsport)
//
// In entrambi i casi il trasporto di gioco è lo stesso: WebRTC DataChannel
// via node-datachannel/polyfill (stesso libdatachannel usato dalla
// GDExtension webrtc-native lato Godot).
//
// Uso:
//   npm install
//   node load_test.js --mode server --room CODICE [--clients 10] [--rate 30] [--duration 20] [--stagger 150]
//   node load_test.js --mode local --ip 1.2.3.4 --wsport 38215 [--clients 10] [--rate 30] [--duration 20] [--stagger 50]
//
// Con --mode server, l'host e i client condividono il rate limit per-IP di
// ntfy.sh durante l'handshake (vedi con-server/README.md): con molti
// --clients aumenta --stagger. Con --mode local non c'è un relay condiviso,
// quindi non c'è quel limite - il collo di bottiglia è solo quanti handshake
// l'host riesce a gestire in parallelo.

const nodeDataChannel = require("node-datachannel");
const { RTCPeerConnection } = require("node-datachannel/polyfill");

const STUN_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const CONNECT_TIMEOUT_MS = 15000;

const NTFY_HOST = "ntfy.sh";
const TOPIC_PREFIX = "gdwebrtc-ctrl";
const HOST_ID = "host";
const NTFY_MAX_RETRIES = 4;

function parseArgs() {
  const args = { clients: 5, rate: 30, duration: 20, stagger: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "mode") args.mode = value;
    else if (key === "room") args.room = value;
    else if (key === "ip") args.ip = value;
    else if (key === "wsport") args.wsport = parseInt(value, 10);
    else if (key === "clients") args.clients = parseInt(value, 10);
    else if (key === "rate") args.rate = parseFloat(value);
    else if (key === "duration") args.duration = parseFloat(value);
    else if (key === "stagger") args.stagger = parseFloat(value);
    else continue;
    i++;
  }
  // Default diverso per --stagger secondo la modalità: ntfy ha un rate
  // limit per-IP da rispettare, la connessione diretta no.
  if (args.stagger === null) args.stagger = args.mode === "server" ? 150 : 50;
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Modalità "server" (con-server/): pub/sub condiviso su ntfy.sh, con
// instradamento from/to perché il topic è condiviso tra host e tutti i
// client. Stessa interfaccia minima delle altre: send(msg) / on_message(msg).
class NtfySignaling {
  constructor(topic) {
    this.topic = topic;
    this.on_message = null;
    this.on_open = null;
    this._ws = null;
  }

  connect() {
    this._ws = new WebSocket(`wss://${NTFY_HOST}/${this.topic}/ws`);
    this._ws.onopen = () => {
      if (this.on_open) this.on_open();
    };
    this._ws.onmessage = (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (envelope.event !== "message") return;
      let payload;
      try {
        payload = JSON.parse(envelope.message);
      } catch (e) {
        return;
      }
      if (this.on_message) this.on_message(payload);
    };
  }

  // Riprova con backoff sui 429 di ntfy (limite di burst per-IP) invece di
  // perdere il messaggio in silenzio.
  async send(msg, attempt = 0) {
    let res;
    try {
      res = await fetch(`https://${NTFY_HOST}/${this.topic}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: JSON.stringify(msg),
      });
    } catch (err) {
      console.error(`[signaling] publish fallita:`, err.message);
      return;
    }
    if (res.status === 429 && attempt < NTFY_MAX_RETRIES) {
      await sleep(800 * (attempt + 1));
      return this.send(msg, attempt + 1);
    }
    if (!res.ok) {
      console.error(`[signaling] publish non riuscita (http ${res.status})`);
    }
  }
}

// --- Modalità "local" (senza-server/): connessione WebSocket diretta e
// dedicata 1:1 verso l'host, nessun instradamento necessario.
class DirectSignaling {
  constructor(ip, wsport) {
    this.ip = ip;
    this.wsport = wsport;
    this.on_message = null;
    this.on_open = null;
    this._ws = null;
  }

  connect() {
    this._ws = new WebSocket(`ws://${this.ip}:${this.wsport}/`);
    this._ws.onopen = () => {
      if (this.on_open) this.on_open();
    };
    this._ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (this.on_message) this.on_message(msg);
    };
  }

  send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }
}

// Un singolo client simulato: handshake completo (con il protocollo giusto
// per la modalità scelta) + flood di "move" + echo dei "ping" dell'host.
class SimulatedClient {
  constructor(index, args) {
    this.index = index;
    this.id = `load-${index}-${Math.random().toString(36).slice(2, 6)}`;
    this.args = args;
    this.messagesSent = 0;
    this.connected = false;
    this.connectTimeMs = null;
    this.failed = false;
  }

  async run() {
    const startedAt = Date.now();
    const isServerMode = this.args.mode === "server";
    const signaling = isServerMode
      ? new NtfySignaling(`${TOPIC_PREFIX}-${this.args.room}`)
      : new DirectSignaling(this.args.ip, this.args.wsport);

    const pc = new RTCPeerConnection(STUN_CONFIG);
    const dc = pc.createDataChannel("input", {
      negotiated: true,
      id: 1,
      ordered: false,
      maxRetransmits: 0,
    });
    this.pc = pc;
    this.dc = dc;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const msg = {
        type: "candidate",
        media: event.candidate.sdpMid,
        // node-datachannel/polyfill non popola sdpMLineIndex (resta sempre
        // null): con un solo DataChannel/m-line è comunque sempre 0.
        index: event.candidate.sdpMLineIndex ?? 0,
        candidate: event.candidate.candidate,
      };
      signaling.send(isServerMode ? { from: this.id, to: HOST_ID, ...msg } : msg);
    };

    dc.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (msg.type === "ping") {
        dc.send(JSON.stringify({ type: "pong", id: msg.id }));
      }
    };

    const openPromise = new Promise((resolve) => {
      dc.onopen = () => resolve(true);
    });

    signaling.on_message = async (msg) => {
      if (isServerMode && msg.to !== this.id) return; // non indirizzato a noi.
      if (msg.type === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const answerMsg = { type: "answer", sdp: answer.sdp };
        signaling.send(isServerMode ? { from: this.id, to: HOST_ID, ...answerMsg } : answerMsg);
      } else if (msg.type === "candidate") {
        try {
          await pc.addIceCandidate({
            sdpMid: msg.media,
            sdpMLineIndex: msg.index,
            candidate: msg.candidate,
          });
        } catch (e) {
          // Candidate tardivo su connessione già chiusa: non fatale.
        }
      }
    };

    if (isServerMode) {
      // Nel topic condiviso bisogna annunciarsi: l'host non sa che esistiamo
      // finché non manda un "hello". Va fatto solo dopo che la subscription
      // è pronta, altrimenti rischiamo di perdere l'offer di risposta.
      signaling.on_open = () => signaling.send({ from: this.id, to: HOST_ID, type: "hello" });
    }
    // In modalità "local" non serve: la connessione WebSocket stessa è il
    // segnale che un client è arrivato, l'host manda l'offer da solo.
    signaling.connect();

    const timeoutPromise = sleep(CONNECT_TIMEOUT_MS).then(() => false);
    const opened = await Promise.race([openPromise, timeoutPromise]);

    if (!opened) {
      this.failed = true;
      console.error(`[${this.id}] timeout: DataChannel non apertosi in ${CONNECT_TIMEOUT_MS}ms`);
      try {
        pc.close();
      } catch (e) {}
      return;
    }

    this.connected = true;
    this.connectTimeMs = Date.now() - startedAt;

    this._flood(this.args.rate, this.args.duration);
  }

  _flood(rate, durationSec) {
    const intervalMs = 1000 / rate;
    this._floodTimer = setInterval(() => {
      if (this.dc.readyState !== "open") return;
      const angle = Math.random() * Math.PI * 2;
      this.dc.send(JSON.stringify({ type: "move", x: Math.cos(angle), y: Math.sin(angle) }));
      this.messagesSent++;
    }, intervalMs);

    setTimeout(() => this.stop(), durationSec * 1000);
  }

  stop() {
    if (this._floodTimer) {
      clearInterval(this._floodTimer);
      this._floodTimer = null;
    }
    try {
      if (this.dc && this.dc.readyState === "open") {
        this.dc.send(JSON.stringify({ type: "move", x: 0, y: 0 }));
      }
    } catch (e) {}
  }

  close() {
    this.stop();
    try {
      this.pc && this.pc.close();
    } catch (e) {}
  }
}

function printUsageAndExit() {
  console.error("Uso:");
  console.error(
    "  node load_test.js --mode server --room CODICE [--clients 10] [--rate 30] [--duration 20] [--stagger 150]"
  );
  console.error(
    "  node load_test.js --mode local --ip <IP> --wsport <PORTA> [--clients 10] [--rate 30] [--duration 20] [--stagger 50]"
  );
  console.error('"server" punta a con-server/ (ntfy.sh), "local" punta a senza-server/ (connessione diretta).');
  process.exit(1);
}

async function main() {
  const args = parseArgs();
  if (args.mode !== "server" && args.mode !== "local") printUsageAndExit();
  if (args.mode === "server" && !args.room) printUsageAndExit();
  if (args.mode === "local" && (!args.ip || !args.wsport)) printUsageAndExit();

  const target = args.mode === "server" ? `stanza "${args.room}" (ntfy.sh)` : `${args.ip}:${args.wsport} (diretto)`;
  console.log(
    `Avvio ${args.clients} client simulati verso ${target}: ` +
      `${args.rate} msg/s a testa per ${args.duration}s, partenza scaglionata ogni ${args.stagger}ms.`
  );

  const clients = [];
  for (let i = 0; i < args.clients; i++) {
    const client = new SimulatedClient(i, args);
    clients.push(client);
    client.run().catch((err) => {
      client.failed = true;
      console.error(`[${client.id}] errore:`, err.message);
    });
    await sleep(args.stagger);
  }

  // Report live ogni secondo mentre il flood è in corso.
  const reportInterval = setInterval(() => {
    const connected = clients.filter((c) => c.connected).length;
    const totalSent = clients.reduce((sum, c) => sum + c.messagesSent, 0);
    console.log(
      `[+${Math.round(process.uptime())}s] connessi: ${connected}/${clients.length} ` +
        `- messaggi "move" inviati in totale: ${totalSent}`
    );
  }, 1000);

  // Attendi che tutti i client abbiano finito (connessi e in flood, oppure falliti).
  const totalWaitMs = CONNECT_TIMEOUT_MS + args.stagger * args.clients + args.duration * 1000 + 2000;
  await sleep(totalWaitMs);
  clearInterval(reportInterval);

  const connected = clients.filter((c) => c.connected);
  const failed = clients.filter((c) => c.failed);
  const totalSent = clients.reduce((sum, c) => sum + c.messagesSent, 0);
  const connectTimes = connected.map((c) => c.connectTimeMs).sort((a, b) => a - b);

  console.log("\n=== Riepilogo ===");
  console.log(`Client connessi:  ${connected.length}/${clients.length}`);
  console.log(`Client falliti:   ${failed.length}/${clients.length}`);
  console.log(`Messaggi "move" totali inviati: ${totalSent}`);
  if (connectTimes.length > 0) {
    const avg = connectTimes.reduce((a, b) => a + b, 0) / connectTimes.length;
    console.log(
      `Tempo di connessione (avvio handshake -> DataChannel aperto): ` +
        `min ${connectTimes[0]}ms, media ${Math.round(avg)}ms, max ${connectTimes[connectTimes.length - 1]}ms`
    );
  }

  for (const c of clients) c.close();
  await sleep(300);
  nodeDataChannel.cleanup();
  process.exit(0);
}

main();
