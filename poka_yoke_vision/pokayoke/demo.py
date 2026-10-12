"""Synthetic board images so you can try the software (and run tests) with no camera.

    python -m pokayoke.demo           -> creates boards/DEMO-HILUX-01 + demo_images/*.png
    python -m pokayoke.app --image demo_images/missing_parts.png
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .board import BoardLibrary, Component
from .inspector import Inspector

W, H = 1280, 720
BOLTS = [(300 + i * 45, 520) for i in range(6)]


def bare_board(seed: int = 7) -> np.ndarray:
    """Plywood-ish board with printed outlines/text = plenty of ORB features to align on."""
    rng = np.random.default_rng(seed)
    img = np.full((H, W, 3), (150, 185, 205), np.uint8)
    noise = rng.normal(0, 10, (H, W, 1)).astype(np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    for _ in range(40):  # marker-pen shadow outlines + labels like a real shadow board
        x, y = int(rng.integers(20, W - 120)), int(rng.integers(20, H - 60))
        cv2.rectangle(img, (x, y), (x + int(rng.integers(30, 100)), y + int(rng.integers(20, 50))), (40, 40, 40), 2)
        cv2.putText(img, f"P{int(rng.integers(100, 999))}", (x + 4, y + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (30, 30, 30), 1)
    cv2.putText(img, "DEMO-HILUX-01", (40, 690), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 3)
    return img


def kitted(img: np.ndarray, bracket=True, seal=True, loom=True, bolts=6, ties=True) -> np.ndarray:
    out = img.copy()
    if bracket:  # zinc bracket
        cv2.rectangle(out, (120, 120), (330, 230), (170, 170, 175), -1)
        cv2.rectangle(out, (120, 120), (330, 230), (90, 90, 95), 3)
        cv2.circle(out, (160, 175), 12, (60, 60, 60), -1); cv2.circle(out, (290, 175), 12, (60, 60, 60), -1)
    if seal:     # black EPDM seal strip
        cv2.rectangle(out, (450, 130), (900, 170), (25, 25, 25), -1)
    if loom:     # loom in clear-ish blue bag
        cv2.rectangle(out, (950, 100), (1180, 330), (200, 120, 60), -1)
        cv2.ellipse(out, (1065, 215), (80, 60), 0, 0, 360, (30, 30, 200), 6)
    if ties:     # bundle of white cable ties
        cv2.rectangle(out, (660, 400), (860, 450), (238, 240, 242), -1)
        for yy in (412, 425, 438):
            cv2.line(out, (668, yy), (852, yy), (205, 208, 210), 2)
    for (x, y) in BOLTS[:bolts]:  # M8 bolts, dark heads
        cv2.circle(out, (x, y), 14, (50, 50, 55), -1)
        cv2.circle(out, (x, y), 5, (110, 110, 115), -1)
    return out


def components() -> list[Component]:
    return [
        Component("c1", "Mounting bracket LH", [110, 110, 230, 130], 1, "presence", "BRK-0412", material="steel"),
        Component("c2", "Door seal 450mm", [440, 120, 470, 60], 1, "presence", "SEAL-EPDM-450", material="black"),
        Component("c3", "Wiring loom bag", [940, 90, 250, 250], 1, "presence", "LOOM-RR-02", material="bag"),
        Component("c4", "M8 x 25 flange bolt", [270, 490, 290, 60], 6, "count", "FAST-M8-25", material="black"),
        Component("c5", "Cable tie bundle", [650, 390, 220, 70], 1, "presence", "TIE-200-WHT", material="white"),
    ]


def build(root: Path, demo_dir: Path) -> str:
    lib = BoardLibrary(root)
    b = lib.create("DEMO-HILUX-01", "Demo canopy fit-out kit", "Hilux DC")
    bare = bare_board()
    b.set_empty(bare)
    b.add_reference(kitted(bare))
    b.components = components()
    Inspector(b).calibrate()
    b.save()
    demo_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(demo_dir / "good.png"), kitted(bare))
    cv2.imwrite(str(demo_dir / "missing_parts.png"), kitted(bare, seal=False, bolts=4))
    cv2.imwrite(str(demo_dir / "wrong_board.png"), kitted(bare_board(seed=99)))
    return b.board_id


if __name__ == "__main__":
    here = Path(__file__).resolve().parent.parent
    print("created", build(here / "boards", here / "demo_images"))
