"""Draw heat map + spaghetti diagram over the base camera frame."""
from __future__ import annotations

import colorsys

import cv2
import numpy as np

from .analysis import Analysis


def _track_colour(i: int) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb((i * 0.618034) % 1, 0.85, 1.0)  # golden-ratio hue spread
    return int(b * 255), int(g * 255), int(r * 255)


def _faded_base(frame: np.ndarray, fade: float = 0.45) -> np.ndarray:
    grey = cv2.cvtColor(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    return cv2.addWeighted(grey, fade, np.full_like(grey, 255), 1 - fade, 0)


def heat_layer(a: Analysis, size: tuple[int, int], sigma: float | None = None) -> np.ndarray:
    """Float map of seconds spent per pixel, Gaussian spread."""
    w, h = size
    acc = np.zeros((h, w), np.float32)
    for path in a.paths:
        for x, y in path.xy:
            xi, yi = int(x), int(y)
            if 0 <= xi < w and 0 <= yi < h:
                acc[yi, xi] += a.sample_dt
    sigma = sigma or max(w, h) / 60
    return cv2.GaussianBlur(acc, (0, 0), sigma)


def draw_heatmap(img: np.ndarray, heat: np.ndarray, alpha: float = 0.65) -> np.ndarray:
    if heat.max() <= 0:
        return img
    norm = np.clip(heat / np.percentile(heat[heat > 0], 99), 0, 1)
    colour = cv2.applyColorMap((norm * 255).astype(np.uint8), cv2.COLORMAP_TURBO)
    a = (np.clip(norm * 2.5, 0, 1) * alpha)[..., None]  # transparent where nobody walked
    return (img * (1 - a) + colour * a).astype(np.uint8)


def draw_spaghetti(img: np.ndarray, a: Analysis, thickness: int | None = None,
                   single_colour: tuple[int, int, int] | None = None, markers: bool = True) -> np.ndarray:
    h, w = img.shape[:2]
    thickness = thickness or max(1, round(max(w, h) / 700))
    layer = img.copy()
    for i, path in enumerate(a.paths):
        col = single_colour or _track_colour(i)
        for piece in path.pieces:
            cv2.polylines(layer, [piece.astype(np.int32)], False, col, thickness, cv2.LINE_AA)
        if not markers:
            continue
        sx, sy = path.pieces[0][0]
        ex, ey = path.pieces[-1][-1]
        cv2.circle(layer, (int(sx), int(sy)), thickness * 3, col, -1, cv2.LINE_AA)       # start
        cv2.rectangle(layer, (int(ex) - thickness * 3, int(ey) - thickness * 3),
                      (int(ex) + thickness * 3, int(ey) + thickness * 3), col, -1)        # end
    return cv2.addWeighted(layer, 0.8, img, 0.2, 0)


def draw_zones(img: np.ndarray, a: Analysis, show_flows: bool = True) -> np.ndarray:
    if not a.zones:
        return img
    h, w = img.shape[:2]
    s = max(w, h) / 1600
    out = img.copy()
    for z in a.zones:
        cv2.polylines(out, [z.poly.astype(np.int32)], True, (40, 40, 40), max(1, int(2 * s)), cv2.LINE_AA)
    if show_flows and a.flows:
        cent = {z.name: z.centroid for z in a.zones}
        top = max(a.flows.values())
        for (src, dst), n in sorted(a.flows.items(), key=lambda kv: kv[1]):
            p1 = tuple(int(v) for v in cent[src])
            p2 = tuple(int(v) for v in cent[dst])
            th = max(1, int(1 + 10 * s * n / top))
            cv2.arrowedLine(out, p1, p2, (30, 30, 200), th, cv2.LINE_AA, tipLength=0.04)
            mid = ((p1[0] + p2[0]) // 2, (p1[1] + p2[1]) // 2)
            cv2.putText(out, str(n), mid, cv2.FONT_HERSHEY_SIMPLEX, 0.6 * s, (30, 30, 200), max(1, int(2 * s)), cv2.LINE_AA)
    for z in a.zones:
        cx, cy = (int(v) for v in z.centroid)
        label = f"{z.name} {a.dwell_s.get(z.name, 0) / 60:.1f} min"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7 * s, max(1, int(2 * s)))
        cv2.rectangle(out, (cx - tw // 2 - 4, cy - th - 6), (cx + tw // 2 + 4, cy + 6), (255, 255, 255), -1)
        cv2.putText(out, label, (cx - tw // 2, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.7 * s, (20, 20, 20),
                    max(1, int(2 * s)), cv2.LINE_AA)
    return out


def draw_legend(img: np.ndarray, a: Analysis) -> np.ndarray:
    """Operator colour key, top-left."""
    if not a.paths:
        return img
    h, w = img.shape[:2]
    s = max(w, h) / 1600
    fs, th, row = 0.6 * s, max(1, int(1.5 * s)), int(26 * s)
    labels = [p.operator for p in a.paths]
    tw = max(cv2.getTextSize(l, cv2.FONT_HERSHEY_SIMPLEX, fs, th)[0][0] for l in labels)
    out = img.copy()
    cv2.rectangle(out, (8, 8), (int(40 * s) + tw + 16, 16 + row * len(labels)), (255, 255, 255), -1)
    for i, label in enumerate(labels):
        y = 14 + row * i + row // 2
        cv2.line(out, (16, y), (int(16 + 22 * s), y), _track_colour(i), max(2, int(4 * s)), cv2.LINE_AA)
        cv2.putText(out, label, (int(24 + 22 * s), y + int(6 * s)), cv2.FONT_HERSHEY_SIMPLEX, fs, (20, 20, 20), th,
                    cv2.LINE_AA)
    return out


def render_operators(base_frame: np.ndarray, a: Analysis) -> dict[str, np.ndarray]:
    """One image per operator: their own heat map + path in their legend colour."""
    h, w = base_frame.shape[:2]
    base = _faded_base(base_frame)
    out = {}
    for i, path in enumerate(a.paths):
        solo = Analysis(paths=[path], zones=a.zones, sample_dt=a.sample_dt,
                        dwell_s=a.dwell_by_op.get(path.operator, {}))
        img = draw_heatmap(base, heat_layer(solo, (w, h)), alpha=0.5)
        img = draw_spaghetti(img, solo, single_colour=_track_colour(i))
        out[path.operator] = draw_zones(img, solo, show_flows=False)
    return out


def render_all(base_frame: np.ndarray, a: Analysis) -> dict[str, np.ndarray]:
    """Returns the three PDF images: combined, heatmap-only, spaghetti-only (BGR)."""
    h, w = base_frame.shape[:2]
    base = _faded_base(base_frame)
    heat = heat_layer(a, (w, h))
    heat_img = draw_heatmap(base, heat)
    # white trails over heat read well; outline them dark so they show on cold areas too
    combined = draw_zones(draw_spaghetti(draw_spaghetti(heat_img, a, single_colour=(30, 30, 30),
                                                        thickness=max(2, round(max(w, h) / 450)), markers=False),
                                         a, single_colour=(255, 255, 255), markers=False), a)
    return {
        "combined": combined,
        "heatmap": draw_zones(heat_img, a, show_flows=False),
        "spaghetti": draw_zones(draw_spaghetti(base, a), a),  # legend added after any crop
    }
