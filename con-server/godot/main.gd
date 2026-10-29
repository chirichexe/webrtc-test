# Host del gioco. All'avvio genera un codice stanza, mostra QR + URL,
# e per ogni telefono che si collega crea una WebRTCPeerConnection dedicata
# con un DataChannel "input". Ogni telefono connesso controlla un omino.
#
# Protocollo sul DataChannel (tutto JSON, tutto taggato con "type"):
#   {"type":"move","x":-1..1,"y":-1..1}  - vettore di movimento dal joystick
#   {"type":"ping","id":N}               - probe di latenza (in entrambe le direzioni)
#   {"type":"pong","id":N}               - risposta immediata a un "ping" con lo stesso id
# Ogni lato, quando riceve un "ping", risponde subito con un "pong": l'host lo
# usa per misurare la latenza verso ogni client (anche quelli del load test),
# il controller lo usa per misurare la latenza verso l'host quando preme un
# tasto di test.
extends Node2D

const TOPIC_PREFIX := "gdwebrtc-ctrl"
const ROOM_CODE_CHARS := "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const ROOM_CODE_LENGTH := 6
# URL base della pagina controller: dove hai pubblicato il contenuto di web/
# (GitHub Pages, Netlify, qualsiasi hosting statico con HTTPS). Aggiornalo
# dopo il deploy - vedi il README di questa cartella.
const PAGES_BASE_URL := "https://TUO-UTENTE.github.io/TUO-REPO/"
const STUN_CONFIG := {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
const PLAYER_SPEED := 300.0
const MY_ID := "host"

const PING_INTERVAL := 1.0  # secondi tra un ping "da host" e il successivo, per peer.
const PING_STALE_MS := 2000  # oltre questa età un ping senza risposta è considerato perso.
const RTT_SAMPLE_CAP := 50  # campioni di round-trip time tenuti per peer (ring buffer).
const STATS_INTERVAL := 0.25  # ogni quanto ricalcolare msg/s e ridisegnare il pannello.

# Tiene insieme peer connection, data channel, omino controllato e statistiche
# di latenza/throughput per ogni telefono connesso.
class PeerInfo:
	var pc: WebRTCPeerConnection
	var dc: WebRTCDataChannel
	var player: Player

	var next_ping_id: int = 0
	var pending_pings: Dictionary = {}  # id -> timestamp di invio (msec)
	var rtt_samples: Array = []  # float, ms, ring buffer
	var pings_sent: int = 0
	var pings_lost: int = 0

	var msgs_this_second: int = 0
	var msgs_per_sec: int = 0

@onready var qr_rect: TextureRect = $UI/QRTextureRect
@onready var room_label: Label = $UI/RoomLabel
@onready var url_label: Label = $UI/URLLabel
@onready var stats_label: Label = $UI/StatsScroll/StatsLabel

var signaling: Signaling
var room_code: String
var topic: String
var peers: Dictionary = {}  # phone_id -> PeerInfo

var _ping_accum: float = 0.0
var _stats_accum: float = 0.0


func _ready() -> void:
	randomize()
	room_code = _generate_room_code()
	topic = "%s-%s" % [TOPIC_PREFIX, room_code]

	signaling = Signaling.new()
	add_child(signaling)
	signaling.on_message.connect(_on_signaling_message)
	signaling.start(topic)

	var full_url := "%s?room=%s" % [PAGES_BASE_URL, room_code]
	room_label.text = "Codice stanza: %s" % room_code
	url_label.text = full_url
	stats_label.text = "In attesa di controller..."
	_show_qr(full_url)

	# Utile da terminale (debug, uso headless, load test): es.
	#   node load_test/load_test.js --room <CODICE>
	print("Codice stanza: ", room_code, "  |  URL: ", full_url)


func _generate_room_code() -> String:
	var s := ""
	for i in ROOM_CODE_LENGTH:
		s += ROOM_CODE_CHARS[randi() % ROOM_CODE_CHARS.length()]
	return s


func _show_qr(text: String) -> void:
	var qr := QrCode.new()
	qr.error_correct_level = QrCode.ErrorCorrectionLevel.LOW
	qr_rect.texture = qr.get_texture(text)
	qr.queue_free()


func _on_signaling_message(msg: Dictionary) -> void:
	if msg.get("to", "") != MY_ID:
		return  # messaggio non indirizzato a noi: ignora.
	var phone_id: String = msg.get("from", "")
	if phone_id.is_empty():
		return
	match msg.get("type", ""):
		"hello":
			_create_peer(phone_id)
		"answer":
			if peers.has(phone_id):
				peers[phone_id].pc.set_remote_description("answer", msg.get("sdp", ""))
		"candidate":
			if peers.has(phone_id):
				# Alcuni client (es. node-datachannel) possono mandare "index": null:
				# int(null) genera un errore di script in GDScript, quindi normalizza
				# prima di convertire.
				var idx = msg.get("index", 0)
				if idx == null:
					idx = 0
				peers[phone_id].pc.add_ice_candidate(
					msg.get("media", ""), int(idx), msg.get("candidate", "")
				)


func _create_peer(phone_id: String) -> void:
	if peers.has(phone_id):
		return

	var pc := WebRTCPeerConnection.new()
	pc.initialize(STUN_CONFIG)
	var dc := pc.create_data_channel(
		"input", {"negotiated": true, "id": 1, "ordered": false, "maxRetransmits": 0}
	)

	pc.session_description_created.connect(func(type: String, sdp: String):
		pc.set_local_description(type, sdp)
		signaling.send({"from": MY_ID, "to": phone_id, "type": type, "sdp": sdp})
	)
	pc.ice_candidate_created.connect(func(media: String, index: int, cand_name: String):
		signaling.send({
			"from": MY_ID, "to": phone_id, "type": "candidate",
			"media": media, "index": index, "candidate": cand_name
		})
	)

	var info := PeerInfo.new()
	info.pc = pc
	info.dc = dc
	info.player = _spawn_player(peers.size())
	peers[phone_id] = info

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
