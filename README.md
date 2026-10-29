# webrtc-test

Controller da telefono per un gioco Godot via WebRTC, collegamento tramite QR code.

Due versioni, in due cartelle:

- `con-server/` - usa ntfy.sh per il signaling. Più semplice.
- `senza-server/` - nessun servizio esterno, il gioco fa da server e usa UPnP.

`tests/` contiene lo script di stress test, funziona con entrambe (vedi i README delle due cartelle).
