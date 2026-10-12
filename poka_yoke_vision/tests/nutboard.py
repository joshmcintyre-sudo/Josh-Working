"""Synthetic board: 4 x 6 grid of M6 nylocs on black foam + mirror-image LH / RH brackets."""
import cv2
import numpy as np

from pokayoke import demo
from pokayoke.board import BoardLibrary, Component
from pokayoke.inspector import Inspector

GX, GY, CELL, ROWS, COLS = 700, 480, 50, 4, 6
FOAM = (35, 35, 38)


def bare():
    img = demo.bare_board(seed=11)
    cv2.rectangle(img, (GX - 10, GY - 10), (GX + COLS * CELL + 10, GY + ROWS * CELL + 10), FOAM, -1)
    return img


def nut(img, cx, cy, black=False):
    pts = np.array([(cx + 15 * np.cos(a), cy + 15 * np.sin(a)) for a in np.linspace(0, 2 * np.pi, 7)[:-1]], np.int32)
    cv2.fillPoly(img, [pts], (30, 30, 30) if black else (176, 177, 181))
    cv2.circle(img, (cx, cy), 8, (190, 140, 90), -1)          # blue nylon insert
    cv2.circle(img, (cx, cy), 4, (40, 40, 40), -1)


def bracket(img, x, y, mirror=False):
    """L-shaped black bracket; mirror=True gives the other hand."""
    poly = np.array([(0, 0), (150, 0), (150, 40), (40, 40), (40, 120), (0, 120)], np.int32)
    if mirror:
        poly[:, 0] = 150 - poly[:, 0]
    cv2.fillPoly(img, [poly + (x, y)], (32, 32, 34))
    cv2.circle(img, (x + (130 if not mirror else 20), y + 20), 7, (95, 95, 98), -1)


def kitted(missing=(), lh=True, rh=True, swap=False, black_nuts=False):
    img = bare()
    for r in range(ROWS):
        for k in range(COLS):
            if (r + 1, k + 1) not in missing:
                nut(img, GX + k * CELL + CELL // 2, GY + r * CELL + CELL // 2, black_nuts)
    if lh:
        bracket(img, 150, 150, mirror=swap)
    if rh:
        bracket(img, 400, 150, mirror=not swap)
    return img


def build(root):
    lib = BoardLibrary(root)
    b = lib.create("PY-NUTS-01", "Nyloc grid test")
    b.set_empty(bare())
    b.add_reference(kitted())
    b.components = [
        Component("g1", "M6 nyloc nut", [GX, GY, COLS * CELL, ROWS * CELL], method="grid", grid_rows=ROWS,
                  grid_cols=COLS, part_number="NUT-M6-NYL", material="steel"),
        Component("lh", "Bracket LH", [140, 140, 170, 140], material="black"),
        Component("rh", "Bracket RH", [390, 140, 170, 140], material="black"),
    ]
    Inspector(b).calibrate()
    b.save()
    return lib.get("PY-NUTS-01")
