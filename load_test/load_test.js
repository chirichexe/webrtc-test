#!/usr/bin/env node
// Stress test: simula N controller che si collegano allo stesso host Godot
// e inondano il DataChannel di messaggi "move", per vedere come l'host
// (vedi godot/main.gd, pannello statistiche) reagisce sotto carico.
// - signaling: WebSocket nativo di Node, connessione diretta all'host
//   (vedi godot/local_server.gd) - nessun server di terze parti.
// - WebRTC: node-datachannel/polyfill (stesso libdatachannel usato dalla
//   GDExtension webrtc-native lato Godot), che espone l'API RTCPeerConnection
//   standard.
//
// Uso:
//   npm install
//   node load_test.js --ip <IP_MOSTRATO_DALL_HOST> --wsport <PORTA_WS> \
//     [--clients 10] [--rate 30] [--duration 20]
//
// Importante: l'host deve già essere in esecuzione; IP e porta WS sono quelli
// mostrati nell'URL sotto il QR code (es. http://1.2.3.4:38214/?wsport=38215
// -> --ip 1.2.3.4 --wsport 38215). Ogni client apre una propria connessione
// WebSocket diretta: non essendoci più un relay condiviso, non c'è un limite
// di burst da rispettare lato signaling (a differenza della vecchia versione
// basata su ntfy.sh). Il vero limite, qui, è quanti handshake TCP/WebRTC
// l'host riesce a gestire in parallelo: con tanti --clients aumenta
// --stagger se noti connessioni che falliscono.

const nodeDataChannel = require("node-datachannel");
const { RTCPeerConnection } = require("node-datachannel/polyfill");

const STUN_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const CONNECT_TIMEOUT_MS = 15000;

function parseArgs() {
  const args = { clients: 5, rate: 30, duration: 20, stagger: 50 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "ip") args.ip = value;
    else if (key === "wsport") args.wsport = parseInt(value, 10);
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

// Stesso modulo di signaling isolato usato da godot/local_server.gd e
// godot/web/signaling.js: connessione diretta 1:1, send(msg) / on_message(msg).
class Signaling {
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

// Un singolo client simulato: handshake completo + flood di "move" + echo
// dei "ping" dell'host (per non rompere le statistiche di latenza lato host
// anche durante il flood).
class SimulatedClient {
  constructor(index, args) {
    this.index = index;
    this.id = `load-${index}`;
    this.args = args;
    this.messagesSent = 0;
    this.connected = false;
    this.connectTimeMs = null;
    this.failed = false;
  }

  async run() {
    const startedAt = Date.now();
    const signaling = new Signaling(this.args.ip, this.args.wsport);
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
      if (msg.type === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.send({ type: "answer", sdp: answer.sdp });
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

    // Appena il WebSocket è aperto l'host sa già che siamo qui (è lui ad
    // averlo accettato) e manda l'offer da solo: non serve un "hello".
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
  if (!args.ip || !args.wsport) {
    console.error(
      "Uso: node load_test.js --ip <IP> --wsport <PORTA> [--clients 10] [--rate 30] [--duration 20] [--stagger 50]"
    );
    console.error('IP e porta sono quelli nell\'URL mostrato dall\'host, es. "http://1.2.3.4:38214/?wsport=38215".');
    process.exit(1);
  }

  console.log(
    `Avvio ${args.clients} client simulati verso ${args.ip}:${args.wsport}: ` +
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
      `Tempo di connessione (WebSocket aperto -> DataChannel aperto): ` +
        `min ${connectTimes[0]}ms, media ${Math.round(avg)}ms, max ${connectTimes[connectTimes.length - 1]}ms`
    );
  }

  for (const c of clients) c.close();
  await sleep(300);
  nodeDataChannel.cleanup();
  process.exit(0);
}

main();
