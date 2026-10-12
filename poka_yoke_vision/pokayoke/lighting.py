"""Lighting robustness: correct uneven / coloured / changing light, and refuse to judge bad images.

The bare-board background (everything outside the part boxes) is the same material in the taught
reference and the live frame, so per-channel live/reference ratios measured there are the lighting
change. A smooth per-channel lighting map is fitted to those ratios on a coarse grid, filled in under
the part boxes from the surrounding board, and divided out. One step corrects dimming, brightening,
gradients across the board, spotlights, soft shadows and warm/cool white balance.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

CELL = 40            # px per lighting-map cell (on a 1280 px frame: 32 x 18 grid)
CLIP = 250           # channel value treated as clipped (glare / over-exposed)


def clahe_gray(img: np.ndarray) -> np.ndarray:
    """Contrast-equalised grey for feature matching: keeps ORB finding the board in dim or flat light."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)


def _fill(grid: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Fill invalid cells from their valid neighbours (normalised convolution, widening until full)."""
    out = grid.copy()
    v = valid.astype(np.float32)
    k = 3
    while (v < 1e-3).any() and k < 4 * max(grid.shape[:2]) + 3:
        num = cv2.blur(out * v[..., None], (k, k))
        den = cv2.blur(v, (k, k))[..., None]
        hole = v < 1e-3
        filled = np.where(den > 1e-3, num / np.maximum(den, 1e-6), out)
        out[hole] = filled[hole]
        v = np.where(hole & (den[..., 0] > 1e-3), 1.0, v)
        k += 4
    return out


def lighting_map(live: np.ndarray, ref: np.ndarray, mask: np.ndarray, cell: int = CELL) -> np.ndarray | None:
    """Per-channel live/ref ratio field (H x W x 3), or None when too little bare board is visible."""
    h, w = ref.shape[:2]
    gw, gh = max(2, w // cell), max(2, h // cell)
    # the map is smooth, so measure it at quarter resolution (16x fewer pixels, same answer)
    sw, sh = max(gw, w // 4), max(gh, h // 4)
    lv = cv2.resize(live, (sw, sh), interpolation=cv2.INTER_AREA)
    rv = cv2.resize(ref, (sw, sh), interpolation=cv2.INTER_AREA)
    mv = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_NEAREST)
    usable = (mv > 0) & (lv.max(axis=2) < CLIP) & (rv.max(axis=2) < CLIP) & (rv.min(axis=2) > 8)
    m = usable.astype(np.float32)
    if m.mean() < 0.05:
        return None
    ratio = (lv.astype(np.float32) + 1.0) / (rv.astype(np.float32) + 1.0)
    num = cv2.resize(ratio * m[..., None], (gw, gh), interpolation=cv2.INTER_AREA)
    den = cv2.resize(m, (gw, gh), interpolation=cv2.INTER_AREA)
    valid = den > 0.15
    grid = np.where(valid[..., None], num / np.maximum(den, 1e-6)[..., None], 1.0).astype(np.float32)
    grid = _fill(grid, valid)
    grid = cv2.GaussianBlur(grid, (3, 3), 0)
    return np.clip(cv2.resize(grid, (w, h), interpolation=cv2.INTER_CUBIC), 0.05, 20.0)


def correct(live: np.ndarray, ref: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Live frame re-lit to match the reference's lighting."""
    field = lighting_map(live, ref, mask)
    if field is None:                                  # fall back: one gain per channel
        k = (mask > 0)
        g = (ref[k].reshape(-1, 3).astype(np.float32).mean(0) + 1) / (live[k].reshape(-1, 3).astype(np.float32).mean(0) + 1) \
            if k.any() else np.ones(3, np.float32)
        return np.clip(live.astype(np.float32) * g, 0, 255).astype(np.uint8)
    return np.clip(live.astype(np.float32) / field, 0, 255).astype(np.uint8)


def match_global(live: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """One gain per channel from the MEDIAN live/ref ratio: a newly placed part (well under half the
    frame) can't skew it. Used in learn mode, where part locations aren't known yet."""
    k = (live.max(axis=2) < CLIP) & (ref.max(axis=2) < CLIP) & (ref.min(axis=2) > 8)
    if k.sum() < 1000:
        return live
    g = np.median((ref[k].astype(np.float32) + 1) / (live[k].astype(np.float32) + 1), axis=0)
    return np.clip(live.astype(np.float32) * g, 0, 255).astype(np.uint8)


@dataclass
class Quality:
    ok: bool
    message: str = ""
    brightness: float = 0.0       # median grey of the visible board, 0-255
    clipped: float = 0.0          # share of board pixels blown out
    relative: float = 1.0         # board brightness vs the taught reference


def assess(live: np.ndarray, ref: np.ndarray | None = None, mask: np.ndarray | None = None) -> Quality:
    """Is this image good enough to judge? Too dark, washed out or covered -> don't PASS or FAIL it."""
    st = 3                                                   # every 3rd pixel: same statistics, ~9x cheaper
    live_s = live[::st, ::st]
    g = cv2.cvtColor(np.ascontiguousarray(live_s), cv2.COLOR_BGR2GRAY)
    k = (mask[::st, ::st] > 0) if mask is not None else np.ones(g.shape, bool)
    if k.sum() < 100:
        k = np.ones(g.shape, bool)
    vals = g[k]
    bright = float(np.median(vals))
    px = live_s[k].reshape(-1, 3)
    clipped = float((px.min(axis=-1) >= CLIP).mean())        # every channel blown = no information
    # detail left in ANY channel counts (bright light can max out grey while blue still carries the image)
    spread = float((np.percentile(px, 95, axis=0) - np.percentile(px, 5, axis=0)).max())
    rel = 1.0
    if ref is not None:
        rg = cv2.cvtColor(np.ascontiguousarray(ref[::st, ::st]), cv2.COLOR_BGR2GRAY)
        rel = (bright + 1) / (float(np.median(rg[k])) + 1)
    q = Quality(True, "", round(bright, 1), round(clipped, 3), round(rel, 2))
    if bright < 18 or rel < 0.12:
        q.ok, q.message = False, "CHECK LIGHTING - too dark, turn lights on / open the camera"
    elif clipped > 0.25:
        q.ok, q.message = False, "CHECK LIGHTING - glare or over-exposed, reduce light or move the lamp"
    elif spread < 4:
        q.ok, q.message = False, "CHECK CAMERA - image is blank or the lens is covered"
    return q
