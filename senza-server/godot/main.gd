# Host del gioco. Non dipende da nessun server esterno: il gioco stesso serve
# la pagina del controller e il canale di signaling (vedi local_server.gd),
# e usa UPNP per farsi raggiungere da internet senza bisogno di una LAN
# condivisa con il telefono. Mostra QR + URL per collegarsi, e per ogni
# telefono che si connette crea una WebRTCPeerConnection dedicata con un
# DataChannel "input". Ogni telefono connesso controlla un omino.
#
# Protocollo sul DataChannel (tutto JSON, tutto taggato con "type"):
#   {"type":"move","x":-1..1,"y":-1..1}  - vettore di movimento dal joystick
#   {"type":"ping","id":N}               - probe di latenza (in entrambe le direzioni)
#   {"type":"pong","id":N}               - risposta immediata a un "ping" con lo stesso id
# Ogni lato, quando riceve un "ping", risponde subito con un "pong": l'host lo
# usa per misurare la latenza verso ogni client (anche quelli del load test),
# il controller lo usa per misurare la latenza verso l'host quando preme un
# tasto di test.
#
# Protocollo di signaling (sul canale WebSocket 1:1, vedi local_server.gd):
# essendo una connessione dedicata per telefono non serve più instradare
# niente con "from"/"to": {"type":"offer"|"answer"|"candidate", ...}.
extends Node2D

const STUN_CONFIG := {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
const PLAYER_SPEED := 300.0

const PING_INTERVAL := 1.0  # secondi tra un ping "da host" e il successivo, per peer.
const PING_STALE_MS := 2000  # oltre questa età un ping senza risposta è considerato perso.
const RTT_SAMPLE_CAP := 50  # campioni di round-trip time tenuti per peer (ring buffer).
const STATS_INTERVAL := 0.25  # ogni quanto ricalcolare msg/s e ridisegnare il pannello.

# Tiene insieme peer connection, data channel, canale di signaling, omino
# controllato e statistiche di latenza/throughput per ogni telefono connesso.
class PeerInfo:
	var pc: WebRTCPeerConnection
	var dc: WebRTCDataChannel
	var conn: LocalServer.PeerConn
	var player: Player

	var next_ping_id: int = 0
	var pending_pings: Dictionary = {}  # id -> timestamp di invio (msec)
	var rtt_samples: Array = []  # float, ms, ring buffer
	var pings_sent: int = 0
	var pings_lost: int = 0

	var msgs_this_second: int = 0
	var msgs_per_sec: int = 0

@onready var qr_rect: TextureRect = $UI/QRTextureRect
@onready var network_label: Label = $UI/NetworkLabel
@onready var url_label: Label = $UI/URLLabel
@onready var stats_label: Label = $UI/StatsScroll/StatsLabel

var local_server: LocalServer
var peers: Dictionary = {}  # phone_id -> PeerInfo
var _next_peer_num: int = 0

var _ping_accum: float = 0.0
var _stats_accum: float = 0.0


func _ready() -> void:
	local_server = LocalServer.new()
	add_child(local_server)
	local_server.client_connected.connect(_on_client_connected)
	local_server.start()

	var full_url := "http://%s:%d/?wsport=%d" % [
		local_server.external_ip, local_server.http_port, local_server.ws_port
	]
	if local_server.upnp_ok:
		network_label.text = "Rete: IP pubblico via UPnP (%s)" % local_server.external_ip
	else:
		network_label.text = "Rete: UPnP non disponibile, solo LAN (%s) - telefono sulla stessa rete" % local_server.external_ip
	url_label.text = full_url
	stats_label.text = "In attesa di controller..."
	_show_qr(full_url)

	# Utile da terminale (debug, uso headless, load test): es.
	#   node load_test/load_test.js --ip <IP> --wsport <PORTA>
	print(network_label.text, "  |  URL: ", full_url)


func _show_qr(text: String) -> void:
	var qr := QrCode.new()
	qr.error_correct_level = QrCode.ErrorCorrectionLevel.LOW
	qr_rect.texture = qr.get_texture(text)
	qr.queue_free()


func _on_client_connected(conn: LocalServer.PeerConn) -> void:
	var phone_id := "client-%d" % _next_peer_num
	_next_peer_num += 1

	var pc := WebRTCPeerConnection.new()
	pc.initialize(STUN_CONFIG)
	var dc := pc.create_data_channel(
		"input", {"negotiated": true, "id": 1, "ordered": false, "maxRetransmits": 0}
	)

	var info := PeerInfo.new()
	info.pc = pc
	info.dc = dc
	info.conn = conn
	info.player = _spawn_player(peers.size())
	peers[phone_id] = info

	pc.session_description_created.connect(func(type: String, sdp: String):
		pc.set_local_description(type, sdp)
		conn.send({"type": type, "sdp": sdp})
	)
	pc.ice_candidate_created.connect(func(media: String, index: int, cand_name: String):
		conn.send({"type": "candidate", "media": media, "index": index, "candidate": cand_name})
	)
	conn.on_message.connect(func(msg: Dictionary):
		match msg.get("type", ""):
			"answer":
				pc.set_remote_description("answer", msg.get("sdp", ""))
			"candidate":
				# Alcuni client (es. node-datachannel) possono mandare "index": null:
				# int(null) genera un errore di script in GDScript, quindi normalizza
				# prima di convertire.
				var idx = msg.get("index", 0)
				if idx == null:
					idx = 0
				pc.add_ice_candidate(msg.get("media", ""), int(idx), msg.get("candidate", ""))
	)

	pc.create_offer()


func _spawn_player(index: int) -> Player:
	var player := Player.new()
	player.color = Color.from_hsv(fmod(index * 0.17, 1.0), 0.8, 0.9)
	player.position = Vector2(300 + (index % 6) * 70, 450 + int(index / 6.0) * 70)
	add_child(player)
	return player


func _send_ping(phone_id: String, info: PeerInfo) -> void:
	_prune_stale_pings(info)
	var id := info.next_ping_id
	info.next_ping_id += 1
	info.pending_pings[id] = Time.get_ticks_msec()
	info.pings_sent += 1
	info.dc.put_packet(JSON.stringify({"type": "ping", "id": id}).to_utf8_buffer())


func _prune_stale_pings(info: PeerInfo) -> void:
	var now := Time.get_ticks_msec()
	var stale_ids := []
	for id in info.pending_pings.keys():
		if now - int(info.pending_pings[id]) > PING_STALE_MS:
			stale_ids.append(id)
	for id in stale_ids:
		info.pending_pings.erase(id)
		info.pings_lost += 1


func _handle_pong(info: PeerInfo, id: int) -> void:
	if not info.pending_pings.has(id):
		return  # pong in ritardo per un ping già contato come perso, o duplicato.
	var sent_at: int = info.pending_pings[id]
	info.pending_pings.erase(id)
	var rtt := float(Time.get_ticks_msec() - sent_at)
	info.rtt_samples.append(rtt)
	if info.rtt_samples.size() > RTT_SAMPLE_CAP:
		info.rtt_samples.pop_front()


func _format_stats(phone_id: String, info: PeerInfo) -> String:
	var n := info.rtt_samples.size()
	var cur := 0.0
	var avg := 0.0
	var mn := 0.0
	var mx := 0.0
	if n > 0:
		cur = info.rtt_samples[n - 1]
		mn = info.rtt_samples[0]
		mx = info.rtt_samples[0]
		var total := 0.0
		for s in info.rtt_samples:
			total += s
			mn = min(mn, s)
			mx = max(mx, s)
		avg = total / n
	var jitter := 0.0
	if n > 1:
		var dev_total := 0.0
		for i in range(1, n):
			dev_total += abs(info.rtt_samples[i] - info.rtt_samples[i - 1])
		jitter = dev_total / (n - 1)
	var loss_pct := 0.0
	if info.pings_sent > 0:
		loss_pct = 100.0 * info.pings_lost / info.pings_sent
	return (
		"%-10s lat=%4.0fms  avg=%4.0fms  min=%4.0fms  max=%4.0fms  jit=%4.0fms  loss=%5.1f%%  in=%4d/s"
		% [phone_id, cur, avg, mn, mx, jitter, loss_pct, info.msgs_per_sec]
	)


func _refresh_stats_label() -> void:
	if peers.is_empty():
		stats_label.text = "In attesa di controller..."
		return
	var lines := ["Controller connessi: %d" % peers.size(), ""]
	for phone_id in peers.keys():
		lines.append(_format_stats(phone_id, peers[phone_id]))
	stats_label.text = "\n".join(lines)


func _process(delta: float) -> void:
	_ping_accum += delta
	var send_pings_now := false
	if _ping_accum >= PING_INTERVAL:
		_ping_accum = 0.0
		send_pings_now = true

	_stats_accum += delta
	var refresh_stats_now := false
	if _stats_accum >= STATS_INTERVAL:
		_stats_accum = 0.0
		refresh_stats_now = true

	for phone_id in peers.keys():
		var info: PeerInfo = peers[phone_id]
		info.pc.poll()
		if info.dc.get_ready_state() != WebRTCDataChannel.STATE_OPEN:
			continue

		while info.dc.get_available_packet_count() > 0:
			var raw := info.dc.get_packet().get_string_from_utf8()
			var data = JSON.parse_string(raw)
			if typeof(data) != TYPE_DICTIONARY:
				continue
			match data.get("type", ""):
				"move":
					var vec := Vector2(data.get("x", 0.0), data.get("y", 0.0))
					info.player.position += vec * PLAYER_SPEED * delta
					info.player.face(vec)
					info.msgs_this_second += 1
				"ping":
					info.dc.put_packet(
						JSON.stringify({"type": "pong", "id": data.get("id", 0)}).to_utf8_buffer()
					)
				"pong":
					_handle_pong(info, int(data.get("id", -1)))

		if send_pings_now:
			_send_ping(phone_id, info)

		if refresh_stats_now:
			info.msgs_per_sec = info.msgs_this_second
			info.msgs_this_second = 0

	if refresh_stats_now:
		_refresh_stats_label()
