# Omino stilizzato (nessun asset grafico): testa + busto + braccia + gambe
# disegnati a runtime. Ruota per guardare nella direzione di movimento.
class_name Player
extends Node2D

var color: Color = Color.WHITE

const HEAD_RADIUS := 8.0
const BODY_LEN := 20.0
const LIMB_LEN := 12.0
const LINE_WIDTH := 3.0


func _draw() -> void:
	# Il disegno è orientato "verso l'alto" (asse -Y locale); la rotazione del
	# nodo lo punta nella direzione di movimento.
	draw_circle(Vector2(0, -BODY_LEN - HEAD_RADIUS), HEAD_RADIUS, color)
	draw_line(Vector2(0, -BODY_LEN), Vector2.ZERO, color, LINE_WIDTH)
	draw_line(Vector2(0, -BODY_LEN + 5), Vector2(-LIMB_LEN, -BODY_LEN + 15), color, LINE_WIDTH)
	draw_line(Vector2(0, -BODY_LEN + 5), Vector2(LIMB_LEN, -BODY_LEN + 15), color, LINE_WIDTH)
	draw_line(Vector2.ZERO, Vector2(-LIMB_LEN, LIMB_LEN), color, LINE_WIDTH)
	draw_line(Vector2.ZERO, Vector2(LIMB_LEN, LIMB_LEN), color, LINE_WIDTH)


# Da chiamare quando il vettore di movimento cambia: orienta l'omino e
# ridisegna. Se il vettore è ~zero, mantiene l'ultimo orientamento.
func face(direction: Vector2) -> void:
	if direction.length() > 0.05:
		rotation = direction.angle() + PI / 2.0
	queue_redraw()
