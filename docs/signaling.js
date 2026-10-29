// Modulo di signaling isolato: usa ntfy.sh come canale pub/sub pubblico
// (nessun server nostro). Interfaccia minima: send(msg) per pubblicare,
// callback on_message(msg) per ricevere. Nessun'altra logica (routing,
// filtraggio per destinatario, ecc.) vive qui: quella sta nel chiamante,
// così questo modulo resta sostituibile con un altro trasporto di signaling.

const NTFY_HOST = "ntfy.sh";
const MAX_RETRIES = 4; // su "429 Too Many Requests" (limite di burst di ntfy.sh).

class Signaling {
  constructor(topic) {
    this.topic = topic;
    // Da impostare dall'esterno: function(msg) {...}
    this.on_message = null;
    // Da impostare dall'esterno (opzionale): function() {...}, chiamata
    // quando la subscription WebSocket è pronta.
    this.on_open = null;
    this._ws = null;
  }

  // Apre la subscription WebSocket al topic ntfy. Va chiamato una sola volta.
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

  // Pubblica un messaggio JSON sul topic via HTTP POST. Se ntfy risponde 429
  // (limite di burst superato, tipico con molti peer che si collegano
  // insieme) riprova con un backoff crescente invece di perdere il
  // messaggio in silenzio.
  async send(msg, attempt = 0) {
    let res;
    try {
      res = await fetch(`https://${NTFY_HOST}/${this.topic}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: JSON.stringify(msg),
      });
    } catch (err) {
      console.error("Signaling: pubblicazione fallita", err.message);
      return;
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return this.send(msg, attempt + 1);
    }
    if (!res.ok) {
      console.error(`Signaling: pubblicazione non riuscita (http ${res.status})`);
    }
  }
}
