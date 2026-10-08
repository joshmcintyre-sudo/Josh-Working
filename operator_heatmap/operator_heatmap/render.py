"""Draw heat map + spaghetti diagram over the base camera frame."""
from __future__ import annotations

import colorsys

import cv2
import numpy as np

from .analysis import Analysis


PERSON_COLOURS = [  # BGR - bright enough for dark backgrounds, distinct from each other
    (255, 255, 0), (0, 230, 255), (255, 0, 255), (80, 255, 80), (255, 140, 30), (60, 60, 255),
    (255, 255, 255), (0, 160, 255), (200, 120, 255), (150, 255, 210), (255, 200, 120), (120, 200, 255)]


def _track_colour(i: int) -> tuple[int, int, int]:
    if i < len(PERSON_COLOURS):
        return PERSON_COLOURS[i]
    r, g, b = colorsys.hsv_to_rgb((i * 0.618034) % 1, 0.8, 1.0)
    return int(b * 255), int(g * 255), int(r * 255)


def _faded_base(frame: np.ndarray, level: float = 0.55) -> np.ndarray:
    """Dark greyscale photo: keeps the layout readable while coloured heat and paths stand out."""
    grey = cv2.cvtColor(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    return (grey * level + 25).astype(np.uint8)


def heat_layer(a: Analysis, size: tuple[int, int], sigma: float | None = None) -> np.ndarray:
    """Float map of seconds spent per pixel, Gaussian spread."""
    w, h = size
    acc = np.zeros((h, w), np.float32)
    for path in a.paths:
        for (x, y), wt in zip(path.xy, path.weights(a.sample_dt)):
            xi, yi = int(x), int(y)
            if 0 <= xi < w and 0 <= yi < h:
                acc[yi, xi] += wt
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
                   single_colour: tuple[int, int, int] | None = None, markers: bool = True,
                   colour_index: dict[str, int] | None = None) -> np.ndarray:
    h, w = img.shape[:2]
    thickness = thickness or max(2, round(max(w, h) / 420))
    layer = img.copy()
    for i, path in enumerate(a.paths):  # dark outline first so lines read on light and dark areas
        for piece in path.pieces:
            cv2.polylines(layer, [piece.astype(np.int32)], False, (0, 0, 0), thickness + 3, cv2.LINE_AA)
    for i, path in enumerate(a.paths):
        col = single_colour or _track_colour(colour_index.get(path.operator, i) if colour_index else i)
        for piece in path.pieces:
            cv2.polylines(layer, [piece.astype(np.int32)], False, col, thickness, cv2.LINE_AA)
        if not markers:
            continue
        sx, sy = path.pieces[0][0]
        ex, ey = path.pieces[-1][-1]
        cv2.circle(layer, (int(sx), int(sy)), thickness * 3, col, -1, cv2.LINE_AA)       # start
        cv2.rectangle(layer, (int(ex) - thickness * 3, int(ey) - thickness * 3),
                      (int(ex) + thickness * 3, int(ey) + thickness * 3), col, -1)        # end
    return layer


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


THROUGH_COLOUR = (150, 150, 150)


def subset(a: Analysis, role: str, names: list[str] | None = None) -> Analysis:
    """Same analysis restricted to operators or through-traffic (keeps zones + sampling)."""
    paths = [p for p in a.paths if a.roles.get(p.operator, "operator") == role and (names is None or p.operator in names)]
    return Analysis(paths=paths, zones=a.zones, sample_dt=a.sample_dt, roles=a.roles,
                    dwell_s={}, colour_index=a.colour_index, dwell_by_op=a.dwell_by_op)


def draw_legend(img: np.ndarray, a: Analysis) -> np.ndarray:
    """Operator colour key, top-left (+ grey through-traffic entry)."""
    ops = subset(a, "operator", a.main_operators or None)
    if not ops.paths and not subset(a, "through").paths:
        return img
    h, w = img.shape[:2]
    s = max(w, h) / 1100
    fs, th, row = 0.6 * s, max(1, int(1.5 * s)), int(26 * s)
    labels = [p.operator for p in ops.paths] + (["Through-traffic"] if subset(a, "through").paths else [])
    tw = max(cv2.getTextSize(l, cv2.FONT_HERSHEY_SIMPLEX, fs, th)[0][0] for l in labels)
    out = img.copy()
    cv2.rectangle(out, (8, 8), (int(40 * s) + tw + 16, 16 + row * len(labels)), (255, 255, 255), -1)
    for i, label in enumerate(labels):
        y = 14 + row * i + row // 2
        col = THROUGH_COLOUR if label == "Through-traffic" else _track_colour(a.colour_index.get(label, i))
        cv2.line(out, (16, y), (int(16 + 22 * s), y), col, max(2, int(4 * s)), cv2.LINE_AA)
        cv2.putText(out, label, (int(24 + 22 * s), y + int(6 * s)), cv2.FONT_HERSHEY_SIMPLEX, fs, (20, 20, 20), th,
                    cv2.LINE_AA)
    return out


def _people_image(base: np.ndarray, a: Analysis, heat_alpha: float = 0.45) -> np.ndarray:
    """Heat (toned down) + bold paths in each person's own colour."""
    h, w = base.shape[:2]
    img = draw_heatmap(base, heat_layer(a, (w, h)), alpha=heat_alpha)
    return draw_spaghetti(img, a, markers=False, colour_index=a.colour_index)


def render_operators(base_frame: np.ndarray, a: Analysis, names: list[str] | None = None) -> dict[str, np.ndarray]:
    """One image per person: their own heat map + path in their legend colour."""
    base = _faded_base(base_frame)
    people = [p for p in a.paths if p.operator in names] if names else subset(a, "operator", a.main_operators or None).paths
    out = {}
    for path in people:
        solo = Analysis(paths=[path], zones=a.zones, sample_dt=a.sample_dt, colour_index=a.colour_index,
                        dwell_s=a.dwell_by_op.get(path.operator, {}))
        out[path.operator] = draw_zones(_people_image(base, solo, heat_alpha=0.6), solo, show_flows=False)
    return out


def render_selection(base_frame: np.ndarray, a: Analysis, names: list[str]) -> np.ndarray:
    """Heat map + paths for just the chosen people (e.g. one operator) - for the app's person filter."""
    sel = Analysis(paths=[p for p in a.paths if p.operator in names], zones=a.zones, sample_dt=a.sample_dt,
                   colour_index=a.colour_index, roles=a.roles)
    sel.dwell_s = {z: sum(a.dwell_by_op.get(n, {}).get(z, 0) for n in names) for z in a.dwell_s}
    return draw_zones(_people_image(_faded_base(base_frame), sel, heat_alpha=0.6), sel, show_flows=False)


def render_all(base_frame: np.ndarray, a: Analysis) -> dict[str, np.ndarray]:
    """PDF images (BGR): everyone, operators only, through-traffic only, heat only, spaghetti."""
    h, w = base_frame.shape[:2]
    base = _faded_base(base_frame)
    ops, thr = subset(a, "operator"), subset(a, "through")
    ops.dwell_s = {z: sum(a.dwell_by_op.get(p.operator, {}).get(z, 0) for p in ops.paths) for z in a.dwell_s}
    main = subset(a, "operator", a.main_operators or None)
    spag = draw_spaghetti(base, thr, single_colour=THROUGH_COLOUR, thickness=max(2, round(max(w, h) / 700)),
                          markers=False)
    return {
        "spaghetti": draw_zones(draw_spaghetti(spag, main, colour_index=a.colour_index), a),  # legend after crop
        "combined": draw_zones(_people_image(base, a), a),
        "operators": draw_zones(_people_image(base, ops), ops),
        "through": draw_zones(_people_image(base, thr), thr, show_flows=False) if thr.paths else None,
        "heatmap": draw_zones(draw_heatmap(base, heat_layer(a, (w, h))), a, show_flows=False),
    }
