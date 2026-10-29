# webrtc-test

Prototipo minimo: controlla un gioco Godot dal telefono, usando il telefono come
controller via WebRTC DataChannel, collegandosi tramite un QR code, **senza che
telefono e PC siano sulla stessa rete**. Nessuno stile o UI curata: l'obiettivo
è solo che il protocollo e la connessione funzionino.

Esistono due versioni, in due cartelle separate, che si differenziano solo per
come avviene il signaling iniziale (lo scambio di offer/answer/candidate WebRTC
prima che la connessione diretta telefono<->PC possa aprirsi):

- [`con-server/`](con-server/) — usa [ntfy.sh](https://ntfy.sh), un servizio
  pub/sub pubblico gratuito, come relay. Più semplice, ma dipende da un
  servizio di terze parti.
- [`senza-server/`](senza-server/) — nessun servizio di terze parti: il gioco
  Godot serve lui stesso la pagina del controller e il canale di signaling, e
  usa UPnP per farsi raggiungere da internet senza bisogno di una LAN
  condivisa. Più complesso e con un limite in più (UPnP non è garantito su
  tutte le reti).

A parità di tutto il resto (joystick a 360°, tasti per il test di latenza,
pannelli di statistiche su host e controller, omino disegnato a runtime): vedi
il README di ciascuna cartella per i dettagli e le istruzioni d'uso.

- [`tests/`](tests/) — script di stress test (`load_test.js`) che simula N
  controller e inonda di input l'host, per studiare latenza e throughput sotto
  carico. Funziona contro entrambe le versioni, scelta con `--mode server`
  (verso `con-server/`) o `--mode local` (verso `senza-server/`).
