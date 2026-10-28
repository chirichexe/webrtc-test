# Host del gioco. All'avvio genera un codice stanza, mostra QR + URL,
# e per ogni telefono che si collega crea una WebRTCPeerConnection dedicata
# con un DataChannel "input". Ogni telefono connesso controlla un quadrato.
extends Node2D

const TOPIC_PREFIX := "gdwebrtc-ctrl"
const ROOM_CODE_CHARS := "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const ROOM_CODE_LENGTH := 6
# URL base della pagina controller su GitHub Pages (aggiornato dallo script di deploy).
const PAGES_BASE_URL := "https://chirichexe.github.io/webrtc-test/"
const STUN_CONFIG := {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
const SQUARE_SPEED := 300.0
const MY_ID := "host"

# Tiene insieme peer connection, data channel e quadrato controllato per ogni telefono.
class PeerInfo:
	var pc: WebRTCPeerConnection
	var dc: WebRTCDataChannel
	var square: ColorRect

@onready var qr_rect: TextureRect = $UI/QRTextureRect
@onready var room_label: Label = $UI/RoomLabel
@onready var url_label: Label = $UI/URLLabel
@onready var status_label: Label = $UI/StatusLabel

var signaling: Signaling
var room_code: String
var topic: String
var peers: Dictionary = {}  # phone_id -> PeerInfo


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
	status_label.text = "In attesa di controller..."
	_show_qr(full_url)


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
				peers[phone_id].pc.add_ice_candidate(
					msg.get("media", ""), int(msg.get("index", 0)), msg.get("candidate", "")
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
	info.square = _spawn_square(peers.size())
	peers[phone_id] = info

	pc.create_offer()
	status_label.text = "Controller connessi: %d" % peers.size()


func _spawn_square(index: int) -> ColorRect:
	var square := ColorRect.new()
	square.size = Vector2(40, 40)
	square.color = Color.from_hsv(fmod(index * 0.17, 1.0), 0.8, 0.9)
	square.position = Vector2(200 + index * 60, 400)
	add_child(square)
	return square


func _process(delta: float) -> void:
	for phone_id in peers.keys():
		var info: PeerInfo = peers[phone_id]
		info.pc.poll()
		if info.dc.get_ready_state() != WebRTCDataChannel.STATE_OPEN:
			continue
		while info.dc.get_available_packet_count() > 0:
			var raw := info.dc.get_packet().get_string_from_utf8()
			var data = JSON.parse_string(raw)
			if typeof(data) == TYPE_DICTIONARY:
				var vx: float = data.get("x", 0.0)
				var vy: float = data.get("y", 0.0)
				info.square.position += Vector2(vx, vy) * SQUARE_SPEED * delta
