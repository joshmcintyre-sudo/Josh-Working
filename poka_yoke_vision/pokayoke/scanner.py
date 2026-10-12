"""Camera barcode reading: order labels (W234566 / S98993), model barcodes, QC badges, board labels.

Uses zxing-cpp (Code 128, Code 39, QR, DataMatrix, EAN/UPC, ...). If it isn't installed,
falls back to OpenCV's QR reader (QR codes only).
"""
from __future__ import annotations

import cv2
import numpy as np

try:
    import zxingcpp
except ImportError:  # pragma: no cover - optional dependency
    zxingcpp = None

BRONZE = (68, 96, 135)


def _zxing(gray: np.ndarray) -> list[dict]:
    out = []
    for r in zxingcpp.read_barcodes(gray):
        if not r.valid or not r.text:
            continue
        p = r.position
        pts = [(p.top_left.x, p.top_left.y), (p.top_right.x, p.top_right.y),
               (p.bottom_right.x, p.bottom_right.y), (p.bottom_left.x, p.bottom_left.y)]
        out.append({"text": r.text.strip(), "format": r.format.name, "points": pts})
    return out


_qr = cv2.QRCodeDetector()


def _opencv(gray: np.ndarray) -> list[dict]:
    ok, texts, pts, _ = _qr.detectAndDecodeMulti(gray)
    if not ok:
        return []
    return [{"text": t.strip(), "format": "QRCode", "points": [tuple(map(int, q)) for q in p]}
            for t, p in zip(texts, pts) if t]


def decode(frame: np.ndarray) -> list[dict]:
    """All barcodes in the frame: [{text, format, points}]. Retries upscaled for small labels."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    reader = _zxing if zxingcpp is not None else _opencv
    codes = reader(gray)
    if not codes and max(gray.shape) < 2400:   # small label far from an overhead camera
        big = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        codes = [{**c, "points": [(x // 2, y // 2) for x, y in c["points"]]} for c in reader(big)]
    seen, uniq = set(), []
    for c in codes:
        if c["text"] not in seen:
            seen.add(c["text"])
            uniq.append(c)
    return uniq


def draw(frame: np.ndarray, codes: list[dict], hint: str = "") -> np.ndarray:
    out = frame.copy()
    for c in codes:
        pts = np.array(c["points"], np.int32).reshape(-1, 1, 2)
        cv2.polylines(out, [pts], True, BRONZE, 4)
        x, y = c["points"][0]
        cv2.putText(out, c["text"], (int(x), max(24, int(y) - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 5)
        cv2.putText(out, c["text"], (int(x), max(24, int(y) - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, BRONZE, 2)
    if hint:
        cv2.rectangle(out, (0, 0), (out.shape[1], 40), (0, 0, 0), -1)
        cv2.putText(out, hint, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    return out


def available() -> str:
    return "zxing-cpp" if zxingcpp is not None else "opencv-qr-only"
