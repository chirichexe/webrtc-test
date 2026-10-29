# Modulo di signaling isolato: usa ntfy.sh come canale pub/sub pubblico
# (niente server nostro). Interfaccia minima: send(msg) per pubblicare,
# segnale on_message(msg) per ricevere. Nessun'altra logica (routing,
# filtraggio per destinatario, ecc.) vive qui: quella sta nel chiamante,
# così questo modulo resta sostituibile con un altro trasporto di signaling.
class_name Signaling
extends Node

signal on_message(msg: Dictionary)

const NTFY_HOST := "ntfy.sh"
const MAX_RETRIES := 4  # su "429 Too Many Requests" (limite di burst di ntfy.sh).

var topic: String = ""
var _ws := WebSocketPeer.new()

# Apre la subscription WebSocket al topic ntfy. Va chiamato una sola volta.
func start(p_topic: String) -> void:
	topic = p_topic
	var err := _ws.connect_to_url("wss://%s/%s/ws" % [NTFY_HOST, topic])
	if err != OK:
		push_error("Signaling: connessione a ntfy.sh fallita (err %d)" % err)

# Pubblica un messaggio JSON sul topic via HTTP POST. Se ntfy risponde 429
# (limite di burst superato, tipico con molti peer che si collegano insieme,
# es. il load test) riprova con un backoff crescente invece di perdere il
# messaggio in silenzio.
func send(msg: Dictionary, attempt: int = 0) -> void:
	if topic.is_empty():
		push_error("Signaling: send() chiamato prima di start()")
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(func(_result: int, code: int, _headers, _body):
		req.queue_free()
		if code == 429 and attempt < MAX_RETRIES:
			await get_tree().create_timer(0.8 * (attempt + 1)).timeout
			send(msg, attempt + 1)
		elif code != 200:
			push_error("Signaling: pubblicazione non riuscita (http %d)" % code)
	)
	var body := JSON.stringify(msg)
	var headers := ["Content-Type: text/plain; charset=utf-8"]
	var err := req.request("https://%s/%s" % [NTFY_HOST, topic], headers, HTTPClient.METHOD_POST, body)
	if err != OK:
		push_error("Signaling: pubblicazione fallita (err %d)" % err)
		req.queue_free()

func _process(_delta: float) -> void:
	_ws.poll()
	if _ws.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	while _ws.get_available_packet_count() > 0:
		var text := _ws.get_packet().get_string_from_utf8()
		var envelope = JSON.parse_string(text)
		if typeof(envelope) != TYPE_DICTIONARY or envelope.get("event") != "message":
			continue
		var payload = JSON.parse_string(envelope.get("message", ""))
		if typeof(payload) == TYPE_DICTIONARY:
			on_message.emit(payload)
