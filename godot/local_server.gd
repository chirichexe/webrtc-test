# Server locale minimo: niente ntfy, niente terze parti. Gira dentro al gioco
# stesso e fa due cose, su due porte TCP separate (Godot non permette di capire
# se una connessione è un upgrade WebSocket o una richiesta HTTP normale DOPO
# averla già passata a WebSocketPeer.accept_stream(), quindi non si possono
# condividere sulla stessa porta):
#   - HTTP_PORT: serve i 3 file statici del controller (letti da res://web/)
#     a chi apre l'URL nel browser del telefono.
#   - WS_PORT: accetta una connessione WebSocket per telefono. Ogni connessione
#     è 1:1 (non un topic pub/sub condiviso): niente più "from"/"to" da
#     instradare, il canale stesso identifica il peer.
# UPNP (classe core di Godot, nessun addon) prova a mappare entrambe le porte
# sul router così da essere raggiungibili da internet, non solo dalla LAN.
# Se UPnP non è disponibile (router con UPnP disattivato, rete aziendale,
# CGNAT...) si ricade sull'IP della LAN: funziona comunque se telefono e PC
# sono sulla stessa rete, ma non oltre - vedi il README.
class_name LocalServer
extends Node

signal client_connected(conn: PeerConn)

const HTTP_PORT := 38214
const WS_PORT := 38215
const UPNP_DISCOVER_TIMEOUT_MS := 2000

# Un singolo canale di signaling 1:1 con un telefono. Stessa interfaccia
# minima del vecchio modulo ntfy-based: send(msg) / segnale on_message(msg).
class PeerConn:
	extends RefCounted
	signal on_message(msg: Dictionary)
	signal closed

	var _ws: WebSocketPeer
	var _was_open := false

	func _init(ws: WebSocketPeer) -> void:
		_ws = ws

	func send(msg: Dictionary) -> void:
		if _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
			_ws.send_text(JSON.stringify(msg))

	func is_open() -> bool:
		return _ws.get_ready_state() == WebSocketPeer.STATE_OPEN

	# Va chiamato ogni frame. Ritorna false quando la connessione è chiusa
	# (il chiamante può così rimuoverla dalle sue strutture).
	func poll() -> bool:
		_ws.poll()
		var state := _ws.get_ready_state()
		if state == WebSocketPeer.STATE_OPEN:
			_was_open = true
			while _ws.get_available_packet_count() > 0:
				var raw := _ws.get_packet().get_string_from_utf8()
				var data = JSON.parse_string(raw)
				if typeof(data) == TYPE_DICTIONARY:
					on_message.emit(data)
		elif state == WebSocketPeer.STATE_CLOSED:
			if _was_open:
				closed.emit()
			return false
		return true


var external_ip: String = ""
var upnp_ok: bool = false
var http_port: int = HTTP_PORT
var ws_port: int = WS_PORT

var _http_tcp := TCPServer.new()
var _ws_tcp := TCPServer.new()
var _pending_http: Dictionary = {}  # StreamPeerTCP -> String (buffer richiesta)
var _connections: Array = []  # PeerConn

var _index_html := ""
var _controller_js := ""
var _signaling_js := ""


func start() -> void:
	_index_html = FileAccess.get_file_as_string("res://web/index.html")
	_controller_js = FileAccess.get_file_as_string("res://web/controller.js")
	_signaling_js = FileAccess.get_file_as_string("res://web/signaling.js")

	var http_err := _http_tcp.listen(HTTP_PORT, "*")
	var ws_err := _ws_tcp.listen(WS_PORT, "*")
	if http_err != OK or ws_err != OK:
		push_error("LocalServer: impossibile aprire le porte locali (%d, %d)" % [http_err, ws_err])

	_setup_networking()


func _setup_networking() -> void:
	var upnp := UPNP.new()
	var disc_err := upnp.discover(UPNP_DISCOVER_TIMEOUT_MS)
	if disc_err == OK and upnp.get_device_count() > 0:
		var map1 := upnp.add_port_mapping(HTTP_PORT, HTTP_PORT, "godot-webrtc-http", "TCP")
		var map2 := upnp.add_port_mapping(WS_PORT, WS_PORT, "godot-webrtc-ws", "TCP")
		if map1 == UPNP.UPNP_RESULT_SUCCESS and map2 == UPNP.UPNP_RESULT_SUCCESS:
			var ext := upnp.query_external_address()
			if ext != "":
				external_ip = ext
				upnp_ok = true

	if not upnp_ok:
		external_ip = _pick_lan_ip()


# Miglior indirizzo IPv4 privato disponibile (per il fallback "solo LAN"
# quando UPnP non è disponibile). Esclude loopback e link-local.
func _pick_lan_ip() -> String:
	for addr in IP.get_local_addresses():
		if addr.count(".") != 3:
			continue  # salta IPv6
		if addr.begins_with("127.") or addr.begins_with("169.254."):
			continue
		if addr.begins_with("192.168.") or addr.begins_with("10.") or _is_172_private(addr):
			return addr
	return "127.0.0.1"


func _is_172_private(addr: String) -> bool:
	if not addr.begins_with("172."):
		return false
	var second := int(addr.split(".")[1])
	return second >= 16 and second <= 31


func _process(_delta: float) -> void:
	_accept_http()
	_accept_ws()
	var still_open := []
	for conn in _connections:
		if conn.poll():
			still_open.append(conn)
	_connections = still_open


func _accept_ws() -> void:
	while _ws_tcp.is_connection_available():
		var tcp: StreamPeerTCP = _ws_tcp.take_connection()
		var ws := WebSocketPeer.new()
		var err := ws.accept_stream(tcp)
		if err == OK:
			var conn := PeerConn.new(ws)
			_connections.append(conn)
			client_connected.emit(conn)


func _accept_http() -> void:
	while _http_tcp.is_connection_available():
		var tcp: StreamPeerTCP = _http_tcp.take_connection()
		_pending_http[tcp] = ""

	var done := []
	for tcp in _pending_http.keys():
		tcp.poll()
		var avail: int = tcp.get_available_bytes()
		if avail > 0:
			_pending_http[tcp] += tcp.get_utf8_string(avail)
		if "\r\n\r\n" in _pending_http[tcp]:
			_respond_http(tcp, _pending_http[tcp])
			done.append(tcp)
		elif tcp.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			done.append(tcp)
	for tcp in done:
		_pending_http.erase(tcp)


func _respond_http(tcp: StreamPeerTCP, request: String) -> void:
	var first_line := request.split("\r\n")[0]
	var parts := first_line.split(" ")
	var path: String = parts[1] if parts.size() > 1 else "/"
	path = path.split("?")[0]  # ignora eventuale query string

	var body: String
	var content_type: String
	var status := "200 OK"
	match path:
		"/", "/index.html":
			body = _index_html
			content_type = "text/html; charset=utf-8"
		"/controller.js":
			body = _controller_js
			content_type = "application/javascript; charset=utf-8"
		"/signaling.js":
			body = _signaling_js
			content_type = "application/javascript; charset=utf-8"
		_:
			body = "Not found"
			content_type = "text/plain; charset=utf-8"
			status = "404 Not Found"

	var body_bytes := body.to_utf8_buffer()
	var response := (
		"HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
		% [status, content_type, body_bytes.size()]
	)
	tcp.put_data(response.to_utf8_buffer())
	tcp.put_data(body_bytes)
	tcp.disconnect_from_host()
