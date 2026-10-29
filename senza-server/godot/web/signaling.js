// Modulo di signaling isolato: connessione WebSocket diretta al gioco Godot,
// che la serve lui stesso (vedi godot/local_server.gd) - nessun server di
// terze parti, nessun topic condiviso: il canale è già 1:1 con l'host.
// Interfaccia minima: send(msg) per pubblicare, callback on_message(msg) per
// ricevere. Così il trasporto resta isolato e sostituibile senza toccare il
// resto del controller.

class Signaling {
  constructor(wsPort) {
    this.wsPort = wsPort;
    // Da impostare dall'esterno: function(msg) {...}
    this.on_message = null;
    // Da impostare dall'esterno (opzionale): function() {...}, chiamata
    // quando la connessione WebSocket è pronta.
    this.on_open = null;
    this._ws = null;
  }

  // Apre la connessione WebSocket diretta verso l'host che ha servito questa
  // pagina (stesso hostname, porta dedicata al signaling).
  connect() {
    this._ws = new WebSocket(`ws://${window.location.hostname}:${this.wsPort}/`);
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

  // Invia un messaggio JSON sul canale diretto.
  send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }
}
