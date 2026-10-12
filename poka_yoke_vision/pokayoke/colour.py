"""Part colour / material rules. Applied to lighting-corrected images, in OpenCV 8-bit LAB
(L 0-255; a, b centred on 128).

steel  - grey / zinc / bright metal: low colour, mid-to-light
black  - black rubber, black-oxide fasteners, black plastic: dark, low colour
white  - white plastic, cable ties, labels: very light, low colour
colour - a coloured part (red clip, blue bag...): hue learned from the taught board
bag    - clear or printed bags: any colour, checked against the taught colour profile
auto   - no rule; colour profile only used to catch an obviously different part
"""
from __future__ import annotations

import math

import numpy as np

MATERIALS = ("auto", "steel", "black", "white", "bag", "colour")
RULED = ("steel", "black", "white", "colour")      # materials with a per-pixel colour rule
PROFILE_TOL = {"auto": 45.0, "bag": 50.0}           # max LAB distance of the part's median colour


def _lch(lab: np.ndarray):
    L = lab[..., 0]
    a = lab[..., 1] - 128.0
    b = lab[..., 2] - 128.0
    return L, np.hypot(a, b), np.degrees(np.arctan2(b, a)) % 360


def class_mask(lab: np.ndarray, material: str, profile: list[float] | None = None) -> np.ndarray | None:
    """Pixels that look like `material` (bool HxW), or None when the material has no pixel rule."""
    L, C, H = _lch(lab)
    # brightness limits follow the part's own taught brightness (tolerates shadows / exposure changes),
    # but never cross into the other class: black stays dark, white stays light, steel stays grey
    L0 = float(profile[0]) if profile else None
    if material == "black":
        top = 85.0 if L0 is None else max(85.0, min(L0 + 45.0, 120.0))
        return (L < top) & (C < 30)
    if material == "white":
        bottom = 195.0 if L0 is None else min(195.0, max(L0 - 50.0, 150.0))
        return (L > bottom) & (C < 30)
    if material == "steel":
        lo, hi = (60.0, 210.0) if L0 is None else (max(40.0, L0 - 70.0), min(235.0, L0 + 70.0))
        return (L >= lo) & (L <= hi) & (C < 25)
    if material == "colour" and profile:
        _, c0, h0 = _lch(np.array(profile, np.float32))
        dh = np.abs((H - float(h0) + 180) % 360 - 180)
        return (dh < 25) & (C > max(15.0, 0.45 * float(c0)))
    return None


def describe(profile: list[float] | None) -> str:
    """Plain word for a median LAB colour: black / white / grey / red / orange / yellow / green / blue / purple."""
    if not profile:
        return "unknown"
    L, C, H = (float(v) for v in _lch(np.array(profile, np.float32)))
    if C < 22:
        return "black" if L < 85 else "white" if L > 195 else "grey"
    for name, hi in (("red", 50), ("orange", 80), ("yellow", 115), ("green", 190), ("blue", 300), ("purple", 345)):   # LAB hue
        if H < hi:
            return name
    return "red"


def suggest(profile: list[float] | None) -> str:
    """Material to pre-select in learn mode from what the camera saw."""
    word = describe(profile)
    return {"black": "black", "white": "white", "grey": "steel", "unknown": "auto"}.get(word, "colour")


def distance(p: list[float] | None, q: list[float] | None) -> float:
    if not p or not q:
        return 0.0
    return math.dist(p, q)
