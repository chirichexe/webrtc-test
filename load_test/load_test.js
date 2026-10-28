#!/usr/bin/env node
// Stress test: simula N controller che si collegano allo stesso host Godot
// (stesso codice stanza) e inondano il DataChannel di messaggi "move", per
// vedere come l'host (vedi godot/main.gd, pannello statistiche) reagisce
// sotto carico. Usa lo stesso protocollo di ntfy.sh e lo stesso schema dei
// messaggi del controller web (docs/controller.js), ma via Node.js:
// - signaling: fetch()/WebSocket nativi di Node, nessuna dipendenza.
// - WebRTC: node-datachannel/polyfill (stesso libdatachannel usato dalla
//   GDExtension webrtc-native lato Godot), che espone l'API RTCPeerConnection
//   standard.
//
// Uso:
//   npm install
//   node load_test.js --room CODICE --clients 10 --rate 30 --duration 20
//
// Importante: l'host deve già essere in esecuzione e mostrare il codice
// stanza da passare con --room. Il signaling (hello/offer/answer/candidate)
// passa da ntfy.sh e ha un limite di burst (vedi README): con molti client
// che partono tutti insieme si rischia di saturarlo. Per questo i client
// vengono avviati con un piccolo ritardo scaglionato (--stagger, default
// 150ms). Una volta stabilita la connessione, il traffico "move" è
// peer-to-peer e non passa più da ntfy: il flood non è quindi limitato da
// quei limiti.

const nodeDataChannel = require("node-datachannel");
const { RTCPeerConnection } = require("node-datachannel/polyfill");

const TOPIC_PREFIX = "gdwebrtc-ctrl";
const NTFY_HOST = "ntfy.sh";
const HOST_ID = "host";
const STUN_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const CONNECT_TIMEOUT_MS = 15000;

function parseArgs() {
  const args = { clients: 5, rate: 30, duration: 20, stagger: 150 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "room") args.room = value;
    else if (key === "clients") args.clients = parseInt(value, 10);
    else if (key === "rate") args.rate = parseFloat(value);
    else if (key === "duration") args.duration = parseFloat(value);
    else if (key === "stagger") args.stagger = parseFloat(value);
    else continue;
    i++;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stesso modulo di signaling isolato usato da godot/signaling.gd e
// docs/signaling.js: send(msg) pubblica su ntfy, on_message(msg) riceve.
class Signaling {
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

  // Come docs/signaling.js: riprova con backoff sui 429 di ntfy invece di
  // perdere il messaggio in silenzio. Con N client che si collegano insieme
  // è il caso comune, non l'eccezione (vedi README).
  async send(msg, attempt = 0) {
    const MAX_RETRIES = 4;
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
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(800 * (attempt + 1));
      return this.send(msg, attempt + 1);
    }
    if (!res.ok) {
      console.error(`[signaling] publish non riuscita (http ${res.status})`);
    }
  }
}

// Un singolo client simulato: handshake completo + flood di "move" + echo
// dei "ping" dell'host (per non rompere le statistiche di latenza lato host
// anche durante il flood).
class SimulatedClient {
  constructor(index, args) {
    this.index = index;
    this.id = `load-${index}-${Math.random().toString(36).slice(2, 6)}`;
    this.args = args;
    this.topic = `${TOPIC_PREFIX}-${args.room}`;
    this.messagesSent = 0;
    this.connected = false;
    this.connectTimeMs = null;
    this.failed = false;
  }

  async run() {
    const startedAt = Date.now();
    const signaling = new Signaling(this.topic);
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
      signaling.send({
        from: this.id,
        to: HOST_ID,
        type: "candidate",
        media: event.candidate.sdpMid,
        // node-datachannel/polyfill non popola sdpMLineIndex (resta sempre
        // null): con un solo DataChannel/m-line è comunque sempre 0.
        index: event.candidate.sdpMLineIndex ?? 0,
        candidate: event.candidate.candidate,
      });
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
      if (msg.to !== this.id) return;
      if (msg.type === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.send({ from: this.id, to: HOST_ID, type: "answer", sdp: answer.sdp });
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

    signaling.on_open = () => {
      signaling.send({ from: this.id, to: HOST_ID, type: "hello" });
    };
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

async function main() {
  const args = parseArgs();
  if (!args.room) {
    console.error("Uso: node load_test.js --room CODICE [--clients 10] [--rate 30] [--duration 20] [--stagger 150]");
    process.exit(1);
  }

  console.log(
    `Avvio ${args.clients} client simulati su stanza "${args.room}": ` +
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
      `Tempo di connessione (hello -> DataChannel aperto): ` +
        `min ${connectTimes[0]}ms, media ${Math.round(avg)}ms, max ${connectTimes[connectTimes.length - 1]}ms`
    );
  }

  for (const c of clients) c.close();
  await sleep(300);
  nodeDataChannel.cleanup();
  process.exit(0);
}

main();
