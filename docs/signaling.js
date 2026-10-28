// Modulo di signaling isolato: usa ntfy.sh come canale pub/sub pubblico
// (nessun server nostro). Interfaccia minima: send(msg) per pubblicare,
// callback on_message(msg) per ricevere. Nessun'altra logica (routing,
// filtraggio per destinatario, ecc.) vive qui: quella sta nel chiamante,
// così questo modulo resta sostituibile con un altro trasporto di signaling.

const NTFY_HOST = "ntfy.sh";

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

  // Pubblica un messaggio JSON sul topic via HTTP POST.
  send(msg) {
    fetch(`https://${NTFY_HOST}/${this.topic}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: JSON.stringify(msg),
    }).catch((err) => console.error("Signaling: pubblicazione fallita", err));
  }
}
