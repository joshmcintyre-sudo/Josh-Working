"""Area isolation: analyse only part of the camera view.

Why: ignore areas that confuse the count (office glass, mezzanine, walkway outside the cell,
reflections, a TV screen) and skip pixels that do not matter -> faster analysis.

Spec (JSON, also accepted under "roi" in the zones config):
{
  "include": [ {"rect": [x1%, y1%, x2%, y2%]},
               {"sector": [from_deg, to_deg, r_in%, r_out%]},   # fisheye pie slice, 0 deg = 12 o'clock, clockwise
               {"poly": [[x, y], ...]} ],                       # pixels of the analysed view
  "exclude": [ ... same shapes ... ]
}
No include shapes = whole view. Excludes are always cut out.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import cv2
import numpy as np


def _shape_to_poly(shape: dict, size: tuple[int, int]) -> np.ndarray:
    w, h = size
    if "poly" in shape:
        return np.array(shape["poly"], np.float32)
    if "rect" in shape:
        x1, y1, x2, y2 = shape["rect"]
        x1, x2 = sorted((x1 * w / 100, x2 * w / 100))
        y1, y2 = sorted((y1 * h / 100, y2 * h / 100))
        return np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], np.float32)
    if "sector" in shape:
        a1, a2, r1, r2 = shape["sector"]
        if a2 <= a1:
            a2 += 360  # wraps past 12 o'clock
        cx, cy, R = w / 2, h / 2, min(w, h) / 2
        ang = np.radians(np.linspace(a1, a2, max(8, int(a2 - a1))) - 90)
        outer = np.stack([cx + R * r2 / 100 * np.cos(ang), cy + R * r2 / 100 * np.sin(ang)], 1)
        inner = np.stack([cx + R * r1 / 100 * np.cos(ang[::-1]), cy + R * r1 / 100 * np.sin(ang[::-1])], 1)
        return np.vstack([outer, inner]).astype(np.float32)
    raise ValueError(f"Unknown ROI shape {shape}")


@dataclass
class ROI:
    size: tuple[int, int]
    include: list[np.ndarray] = field(default_factory=list)
    exclude: list[np.ndarray] = field(default_factory=list)

    @classmethod
    def from_spec(cls, spec: dict | str | None, size: tuple[int, int]) -> "ROI | None":
        if not spec:
            return None
        if isinstance(spec, str):
            spec = json.loads(spec)
        roi = cls(size, [_shape_to_poly(s, size) for s in spec.get("include", [])],
                  [_shape_to_poly(s, size) for s in spec.get("exclude", [])])
        return roi if roi.include or roi.exclude else None

    @property
    def mask(self) -> np.ndarray:
        if not hasattr(self, "_mask"):
            w, h = self.size
            m = np.zeros((h, w), np.uint8) if self.include else np.full((h, w), 255, np.uint8)
            for p in self.include:
                cv2.fillPoly(m, [p.astype(np.int32)], 255)
            for p in self.exclude:
                cv2.fillPoly(m, [p.astype(np.int32)], 0)
            self._mask = m
        return self._mask

    def bbox(self, margin: float = 0.03) -> tuple[int, int, int, int]:
        """Bounding box of the analysed area (x1, y1, x2, y2) with a small margin."""
        ys, xs = np.nonzero(self.mask)
        if not len(xs):
            raise ValueError("Area selection leaves nothing to analyse")
        w, h = self.size
        mx, my = int(w * margin), int(h * margin)
        return max(0, xs.min() - mx), max(0, ys.min() - my), min(w, xs.max() + mx + 1), min(h, ys.max() + my + 1)

    def contains(self, x: float, y: float) -> bool:
        xi, yi = int(x), int(y)
        h, w = self.mask.shape
        return 0 <= xi < w and 0 <= yi < h and self.mask[yi, xi] > 0

    @property
    def coverage(self) -> float:
        return float((self.mask > 0).mean())


def preview(frame: np.ndarray, roi: ROI | None) -> np.ndarray:
    """Dim what is ignored, outline what is analysed - for the app preview and the PDF."""
    if roi is None:
        return frame
    m = roi.mask
    dim = (frame * 0.25).astype(np.uint8)
    out = np.where(m[..., None] > 0, frame, dim)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, cnts, -1, (255, 160, 0), max(2, frame.shape[1] // 600), cv2.LINE_AA)
    return out
