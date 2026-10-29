// Controller telefono: si collega al gioco Godot via WebRTC DataChannel.
// La pagina stessa (index.html, controller.js, signaling.js) è servita dal
// gioco - niente GitHub Pages, niente server di terze parti. Il signaling
// (offer/answer/candidate) passa su una connessione WebSocket diretta e
// dedicata verso l'host (vedi signaling.js e godot/local_server.gd): niente
// topic condiviso, niente "from"/"to" da instradare, il canale stesso è il
// peer.
//
// Protocollo sul DataChannel (vedi anche godot/main.gd):
//   {"type":"move","x":-1..1,"y":-1..1}  - vettore di movimento dal joystick
//   {"type":"ping","id":N}               - probe di latenza
//   {"type":"pong","id":N}               - risposta a un "ping" con lo stesso id

const STUN_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const MOVE_HZ = 30;
const RTT_SAMPLE_CAP = 50;

const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

const params = new URLSearchParams(window.location.search);
const wsPort = params.get("wsport");

if (!wsPort) {
  setStatus("URL non valido: manca ?wsport=... (riapri dal QR code mostrato dal gioco).");
} else {
  startController(parseInt(wsPort, 10));
}

function startController(wsPort) {
  setStatus("Connessione al gioco...");

  const signaling = new Signaling(wsPort);
  const pc = new RTCPeerConnection(STUN_CONFIG);
  const dc = pc.createDataChannel("input", {
    negotiated: true,
    id: 1,
    ordered: false,
    maxRetransmits: 0,
  });

  const stats = new LatencyStats(RTT_SAMPLE_CAP);
  let nextPingId = 0;
  const pendingPings = new Map(); // id -> timestamp di invio (ms, performance.now())

  dc.onopen = () => setStatus("Connesso al gioco!");
  dc.onclose = () => setStatus("Disconnesso dal gioco.");
  dc.onerror = (e) => console.error("DataChannel error", e);

  dc.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (msg.type === "ping") {
      dc.send(JSON.stringify({ type: "pong", id: msg.id }));
    } else if (msg.type === "pong") {
      const sentAt = pendingPings.get(msg.id);
      if (sentAt !== undefined) {
        pendingPings.delete(msg.id);
        stats.addSample(performance.now() - sentAt);
      }
    }
  };

  function sendPing() {
    if (dc.readyState !== "open") return;
    const id = nextPingId++;
    pendingPings.set(id, performance.now());
    dc.send(JSON.stringify({ type: "ping", id }));
    // Un ping senza risposta entro 2s viene contato come perso.
    setTimeout(() => {
      if (pendingPings.delete(id)) stats.addLoss();
    }, 2000);
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    signaling.send({
      type: "candidate",
      media: event.candidate.sdpMid,
      index: event.candidate.sdpMLineIndex,
      candidate: event.candidate.candidate,
    });
  };

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
        console.error("addIceCandidate failed", e);
      }
    }
  };

  // Appena la connessione WebSocket è aperta, l'host sa già che siamo qui
  // (è lui ad averla accettata) e manda l'offer da solo: non serve nessun
  // messaggio di "hello" esplicito.
  signaling.on_open = () => setStatus("In attesa dell'offerta dal gioco...");
  signaling.connect();

  setupJoystick(dc);
  setupPingButtons(sendPing);
  setupStatsLoop(stats);
}

// --- Joystick virtuale a 360 gradi (touch + mouse via Pointer Events) ---

function setupJoystick(dc) {
  const base = document.getElementById("joystick-base");
  const nub = document.getElementById("joystick-nub");
  const maxRadius = base.clientWidth / 2;

  let active = false;
  let vecX = 0;
  let vecY = 0;
  let sendTimer = null;

  function sendVector(x, y) {
    if (dc.readyState !== "open") return;
    dc.send(JSON.stringify({ type: "move", x, y }));
  }

  function updateFromPointer(clientX, clientY) {
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    vecX = dx / maxRadius;
    vecY = dy / maxRadius;
  }

  function resetNub() {
    nub.style.transform = "translate(0px, 0px)";
    vecX = 0;
    vecY = 0;
  }

  function onPointerDown(e) {
    base.setPointerCapture(e.pointerId);
    active = true;
    updateFromPointer(e.clientX, e.clientY);
    if (!sendTimer) {
      sendTimer = setInterval(() => sendVector(vecX, vecY), 1000 / MOVE_HZ);
    }
  }

  function onPointerMove(e) {
    if (!active) return;
    updateFromPointer(e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    if (!active) return;
    active = false;
    resetNub();
    if (sendTimer) {
      clearInterval(sendTimer);
      sendTimer = null;
    }
    sendVector(0, 0);
  }

  base.addEventListener("pointerdown", onPointerDown);
  base.addEventListener("pointermove", onPointerMove);
  base.addEventListener("pointerup", onPointerUp);
  base.addEventListener("pointercancel", onPointerUp);
}

// --- Tasti di test latenza: ognuno spara un ping indipendente ---

function setupPingButtons(sendPing) {
  const buttons = document.querySelectorAll(".ping-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sendPing();
      btn.classList.add("pressed");
    });
    btn.addEventListener("pointerup", () => btn.classList.remove("pressed"));
    btn.addEventListener("pointercancel", () => btn.classList.remove("pressed"));
  });
}

// --- Statistiche di latenza: numero corrente + min/avg/max/jitter/loss + sparkline ---

class LatencyStats {
  constructor(cap) {
    this.cap = cap;
    this.samples = [];
    this.sent = 0;
    this.lost = 0;
  }

  addSample(rtt) {
    this.sent++;
    this.samples.push(rtt);
    if (this.samples.length > this.cap) this.samples.shift();
  }

  addLoss() {
    this.sent++;
    this.lost++;
  }

  summary() {
    const n = this.samples.length;
    if (n === 0) return { cur: 0, avg: 0, min: 0, max: 0, jitter: 0, lossPct: 0 };
    const cur = this.samples[n - 1];
    let min = this.samples[0];
    let max = this.samples[0];
    let total = 0;
    for (const s of this.samples) {
      total += s;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const avg = total / n;
    let jitterTotal = 0;
    for (let i = 1; i < n; i++) jitterTotal += Math.abs(this.samples[i] - this.samples[i - 1]);
    const jitter = n > 1 ? jitterTotal / (n - 1) : 0;
    const lossPct = this.sent > 0 ? (100 * this.lost) / this.sent : 0;
    return { cur, avg, min, max, jitter, lossPct };
  }
}

function setupStatsLoop(stats) {
  const curEl = document.getElementById("stat-current");
  const detailEl = document.getElementById("stat-detail");
  const canvas = document.getElementById("latency-sparkline");
  const ctx = canvas.getContext("2d");
  // Il buffer del canvas deve combaciare con la dimensione CSS reale, altrimenti
  // la linea viene stirata/sfocata dal ridimensionamento del browser.
  canvas.width = canvas.clientWidth;

  // Colori dal design system (palette dataviz, slot sequenziale "blue", dark mode).
  const LINE_COLOR = "#3987e5";
  const BASELINE_COLOR = "#383835";
  const SURFACE_COLOR = "#1a1a19";

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = SURFACE_COLOR;
    ctx.fillRect(0, 0, w, h);

    const samples = stats.samples;
    if (samples.length < 2) return;

    const maxVal = Math.max(50, ...samples); // scala minima 50ms per non far "tremare" il grafico
    const stepX = w / (stats.cap - 1);
    const xOffset = w - (samples.length - 1) * stepX;

    ctx.strokeStyle = BASELINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();

    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = xOffset + i * stepX;
      const y = h - (Math.min(s, maxVal) / maxVal) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Punto arrotondato sull'ultimo campione (data-end).
    const lastX = xOffset + (samples.length - 1) * stepX;
    const lastY = h - (Math.min(samples[samples.length - 1], maxVal) / maxVal) * (h - 4) - 2;
    ctx.fillStyle = LINE_COLOR;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  setInterval(() => {
    const s = stats.summary();
    curEl.textContent = `${Math.round(s.cur)} ms`;
    detailEl.textContent =
      `media ${Math.round(s.avg)}ms · min ${Math.round(s.min)}ms · ` +
      `max ${Math.round(s.max)}ms · jitter ${Math.round(s.jitter)}ms · ` +
      `perdita ${s.lossPct.toFixed(1)}%`;
    draw();
  }, 150);
}
