// Controller telefono: si collega al gioco Godot via WebRTC DataChannel,
// usando ntfy.sh solo per lo scambio iniziale di offer/answer/candidate
// (vedi signaling.js). Nessuna dipendenza esterna, nessun build step.

const TOPIC_PREFIX = "gdwebrtc-ctrl";
const STUN_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const MY_ID = "p-" + Math.random().toString(36).slice(2, 8);
const HOST_ID = "host";
const SEND_HZ = 30;

const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

const params = new URLSearchParams(window.location.search);
const room = params.get("room");

if (!room) {
  setStatus("Nessun codice stanza nell'URL (?room=...). Scansiona il QR code mostrato dal gioco.");
} else {
  startController(room);
}

function startController(roomCode) {
  const topic = `${TOPIC_PREFIX}-${roomCode}`;
  setStatus("Connessione al signaling...");

  const signaling = new Signaling(topic);
  const pc = new RTCPeerConnection(STUN_CONFIG);
  const dc = pc.createDataChannel("input", {
    negotiated: true,
    id: 1,
    ordered: false,
    maxRetransmits: 0,
  });

  dc.onopen = () => setStatus("Connesso al gioco!");
  dc.onclose = () => setStatus("Disconnesso dal gioco.");
  dc.onerror = (e) => console.error("DataChannel error", e);

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    signaling.send({
      from: MY_ID,
      to: HOST_ID,
      type: "candidate",
      media: event.candidate.sdpMid,
      index: event.candidate.sdpMLineIndex,
      candidate: event.candidate.candidate,
    });
  };

  pc.onconnectionstatechange = () => {
    console.log("PeerConnection state:", pc.connectionState);
  };

  signaling.on_message = async (msg) => {
    if (msg.to !== MY_ID) return; // messaggio non indirizzato a noi: ignora.
    if (msg.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signaling.send({ from: MY_ID, to: HOST_ID, type: "answer", sdp: answer.sdp });
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

  // Aspetta che la subscription sia pronta prima di annunciarsi,
  // altrimenti rischiamo di perdere l'offer che l'host invia in risposta.
  signaling.on_open = () => {
    setStatus("In attesa del gioco...");
    signaling.send({ from: MY_ID, to: HOST_ID, type: "hello" });
  };
  signaling.connect();

  setupButtons(dc);
}

function setupButtons(dc) {
  const pressed = { up: false, down: false, left: false, right: false };
  let sendTimer = null;

  function currentVector() {
    const x = (pressed.right ? 1 : 0) - (pressed.left ? 1 : 0);
    const y = (pressed.down ? 1 : 0) - (pressed.up ? 1 : 0);
    return { x, y };
  }

  function sendVector(x, y) {
    if (dc.readyState !== "open") return;
    dc.send(JSON.stringify({ x, y }));
  }

  function anyPressed() {
    return pressed.up || pressed.down || pressed.left || pressed.right;
  }

  function onPress(dir) {
    pressed[dir] = true;
    if (!sendTimer) {
      sendTimer = setInterval(() => {
        const v = currentVector();
        sendVector(v.x, v.y);
      }, 1000 / SEND_HZ);
    }
  }

  function onRelease(dir) {
    pressed[dir] = false;
    if (!anyPressed() && sendTimer) {
      clearInterval(sendTimer);
      sendTimer = null;
      sendVector(0, 0);
    }
  }

  for (const dir of ["up", "down", "left", "right"]) {
    const btn = document.getElementById("btn-" + dir);
    // Touch (telefono).
    btn.addEventListener("touchstart", (e) => { e.preventDefault(); onPress(dir); });
    btn.addEventListener("touchend", (e) => { e.preventDefault(); onRelease(dir); });
    btn.addEventListener("touchcancel", (e) => { e.preventDefault(); onRelease(dir); });
    // Mouse (test da desktop).
    btn.addEventListener("mousedown", () => onPress(dir));
    btn.addEventListener("mouseup", () => onRelease(dir));
    btn.addEventListener("mouseleave", () => onRelease(dir));
  }
}
