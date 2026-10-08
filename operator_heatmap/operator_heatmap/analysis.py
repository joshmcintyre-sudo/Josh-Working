"""Turn raw track points into clean paths, zone dwell times and zone-to-zone flows."""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field

import cv2
import numpy as np

from .tracker import TrackPoint


@dataclass
class Zone:
    name: str
    poly: np.ndarray  # (N, 2) pixel coords in the analysed view

    @property
    def centroid(self) -> tuple[float, float]:
        m = cv2.moments(self.poly.astype(np.float32))
        if m["m00"] == 0:
            return tuple(self.poly.mean(axis=0))
        return m["m10"] / m["m00"], m["m01"] / m["m00"]

    def contains(self, x: float, y: float) -> bool:
        return cv2.pointPolygonTest(self.poly.astype(np.float32), (float(x), float(y)), False) >= 0


@dataclass
class Calibration:
    """Image -> floor (metres). Either a 4-point homography or a flat px-per-metre scale."""
    H: np.ndarray | None = None
    px_per_m: float | None = None
    fisheye: dict | None = None  # {"R", "height_m", "lens_fov_deg", "model"} - ceiling fisheye, no targets needed

    @property
    def calibrated(self) -> bool:
        return self.H is not None or bool(self.px_per_m) or self.fisheye is not None

    def to_floor(self, pts: np.ndarray) -> np.ndarray | None:
        if self.fisheye is not None:
            from .fisheye import floor_metres
            return floor_metres(pts, **self.fisheye)
        if self.H is not None:
            return cv2.perspectiveTransform(pts.reshape(-1, 1, 2).astype(np.float32), self.H).reshape(-1, 2)
        if self.px_per_m:
            return pts / self.px_per_m
        return None


def load_config(path: str | None) -> tuple[list[Zone], Calibration]:
    """JSON: {"zones": {"Press 1": [[x,y],...]}, "calibration": {"image": [[x,y]x4], "floor_m": [[x,y]x4]} | {"px_per_m": 85}}"""
    if not path:
        return [], Calibration()
    with open(path) as fh:
        cfg = json.load(fh)
    zones = [Zone(n, np.array(p, float)) for n, p in cfg.get("zones", {}).items()]
    cal = cfg.get("calibration", {})
    if "image" in cal and "floor_m" in cal:
        H = cv2.getPerspectiveTransform(np.float32(cal["image"]), np.float32(cal["floor_m"]))
        return zones, Calibration(H=H)
    return zones, Calibration(px_per_m=cal.get("px_per_m"))


# --------------------------------------------------------------------------- identities

@dataclass
class Tracklet:
    tid: int
    t0: float
    t1: float
    p0: np.ndarray
    p1: np.ndarray
    hist: np.ndarray | None
    n: int


def _tracklets(points: list[TrackPoint], appearance: dict[int, np.ndarray], min_points: int) -> list[Tracklet]:
    by_id: dict[int, list[TrackPoint]] = defaultdict(list)
    for p in points:
        by_id[p.track_id].append(p)
    out = []
    for tid, pts in by_id.items():
        if len(pts) < min_points:
            continue
        pts.sort(key=lambda p: p.t)
        xy = np.array([[p.x, p.y] for p in pts])
        h = appearance.get(tid)
        out.append(Tracklet(tid, pts[0].t, pts[-1].t, np.median(xy[:3], 0), np.median(xy[-3:], 0),
                            None if h is None else (h / (h.sum() + 1e-9)).astype(np.float32), len(pts)))
    return out


def _app_dist(a, b) -> float:
    """0 = same clothing colours, 1 = completely different."""
    if a is None or b is None:
        return 0.5
    return float(cv2.compareHist(a, b, cv2.HISTCMP_BHATTACHARYYA))


def resolve_identities(points: list[TrackPoint], appearance: dict[int, np.ndarray], view_size: tuple[int, int],
                       n_operators: int | None = None, labels: dict[int, str] | None = None,
                       max_gap_s: float = 15.0, max_app: float = 0.45, min_points: int = 3) -> dict[int, str]:
    """Map raw tracker IDs -> operator names.

    1. Stitch: track B continues track A if B starts after A ends, the jump is walkable in the gap,
       and clothing colours match (occlusion behind racking/pillars, missed detections).
    2. Headcount hint: if you know N operators work the cell, merge the remaining chains by
       appearance (never merging two that are on screen at the same time) until N remain.
    3. Manual labels from the app override everything ("ignore" drops a track, e.g. forklift driver).
    """
    tls = {t.tid: t for t in _tracklets(points, appearance, min_points)}
    diag = float(np.hypot(*view_size))
    walk_px_s, slack = diag / 6, diag * 0.05

    # 1. stitching - greedy on cost, each track gets at most one successor/predecessor
    cands = []
    for a in tls.values():
        for b in tls.values():
            gap = b.t0 - a.t1
            if a.tid == b.tid or gap < -0.5 or gap > max_gap_s:
                continue
            dist = float(np.linalg.norm(b.p0 - a.p1))
            reach = walk_px_s * max(gap, 0.2) + slack
            app = _app_dist(a.hist, b.hist)
            if dist <= reach and app <= max_app:
                cands.append((app + 0.5 * dist / reach + 0.02 * max(gap, 0), a.tid, b.tid))
    nxt, prv = {}, {}
    for _, a, b in sorted(cands):
        if a not in nxt and b not in prv and _root(prv, a) != b:
            nxt[a], prv[b] = b, a
    groups: list[list[int]] = []
    for tid in sorted(tls, key=lambda k: tls[k].t0):
        if tid in prv:
            continue
        chain = [tid]
        while chain[-1] in nxt:
            chain.append(nxt[chain[-1]])
        groups.append(chain)

    # 2. headcount hint
    if n_operators:
        def sig(g):
            hs = [tls[t].hist * tls[t].n for t in g if tls[t].hist is not None]
            return (sum(hs) / (sum(h.sum() for h in hs) + 1e-9)).astype(np.float32) if hs else None

        def overlap(g1, g2):
            return sum(max(0.0, min(tls[a].t1, tls[b].t1) - max(tls[a].t0, tls[b].t0)) for a in g1 for b in g2)

        def span(g):
            return sum(tls[t].t1 - tls[t].t0 for t in g)

        while len(groups) > n_operators:
            sigs = [sig(g) for g in groups]
            best = None
            for i in range(len(groups)):
                for j in range(i + 1, len(groups)):
                    # both visible at once -> two different people (small allowance for swap-cut lag)
                    if overlap(groups[i], groups[j]) > max(2.0, 0.05 * min(span(groups[i]), span(groups[j]))):
                        continue
                    d = _app_dist(sigs[i], sigs[j])
                    if best is None or d < best[0]:
                        best = (d, i, j)
            if best is None:
                # Still more groups than people: the extras are duplicate boxes of someone already
                # tracked (person split by a post, reflection). Fold the smallest into its best match.
                j = min(range(len(groups)), key=lambda k: span(groups[k]))
                i = min((k for k in range(len(groups)) if k != j), key=lambda k: _app_dist(sigs[k], sigs[j]))
                best = (0, min(i, j), max(i, j))
            _, i, j = best
            groups[i] += groups.pop(j)

    groups.sort(key=lambda g: min(tls[t].t0 for t in g))
    mapping = {t: f"Operator {k + 1}" for k, g in enumerate(groups) for t in g}

    # 3. manual overrides
    for tid, name in (labels or {}).items():
        name = (name or "").strip()
        if name:
            mapping[int(tid)] = name
    return {t: n for t, n in mapping.items() if n.lower() != "ignore"}


def _root(prv: dict, t: int) -> int:
    while t in prv:
        t = prv[t]
    return t


def tracklet_table(points: list[TrackPoint], mapping: dict[int, str]) -> list[dict]:
    """One row per raw track - feeds the relabel table in the app."""
    by_id: dict[int, list[float]] = defaultdict(list)
    for p in points:
        by_id[p.track_id].append(p.t)
    rows = []
    for tid, ts in sorted(by_id.items(), key=lambda kv: min(kv[1])):
        rows.append({"track": tid, "start_s": round(min(ts), 1), "end_s": round(max(ts), 1),
                     "seen_s": round(max(ts) - min(ts), 1), "operator": mapping.get(tid, "")})
    return rows


# --------------------------------------------------------------------------- paths

@dataclass
class Path:
    operator: str
    t: np.ndarray
    xy: np.ndarray            # (N, 2) image px
    pieces: list[np.ndarray]  # path split at gaps/teleports -> what gets drawn

    @property
    def duration(self) -> float:
        return float(self.t[-1] - self.t[0])

    def length_px(self) -> float:
        return float(sum(np.linalg.norm(np.diff(p, axis=0), axis=1).sum() for p in self.pieces))


@dataclass
class Analysis:
    paths: list[Path]
    zones: list[Zone]
    dwell_s: dict[str, float] = field(default_factory=dict)
    flows: dict[tuple[str, str], int] = field(default_factory=dict)
    distance_m: dict[str, float] = field(default_factory=dict)
    dwell_by_op: dict[str, dict[str, float]] = field(default_factory=dict)
    active_s: dict[str, float] = field(default_factory=dict)
    sample_dt: float = 0.2


def build_paths(points: list[TrackPoint], sample_fps: float, mapping: dict[int, str] | None = None,
                min_seconds: float = 2.0, max_gap_s: float = 2.0, max_jump_px: float = 200,
                smooth: int = 3) -> list[Path]:
    by_id: dict[str, list[TrackPoint]] = defaultdict(list)
    for p in points:
        if mapping is None:
            by_id[f"Track {p.track_id}"].append(p)
        elif p.track_id in mapping:
            by_id[mapping[p.track_id]].append(p)
    paths = []
    for tid, pts in by_id.items():
        pts.sort(key=lambda p: p.t)
        t = np.array([p.t for p in pts])
        if len(t) < 2 or t[-1] - t[0] < min_seconds:
            continue  # flicker / false positive
        xy = np.array([[p.x, p.y] for p in pts], float)
        if smooth > 1 and len(xy) >= smooth:  # moving average to remove box jitter
            k = np.ones(smooth) / smooth
            pad = smooth // 2
            for c in range(2):
                col = np.pad(xy[:, c], pad, mode="edge")
                xy[:, c] = np.convolve(col, k, mode="valid")[: len(xy)]
        breaks = np.where((np.diff(t) > max_gap_s) |
                          (np.linalg.norm(np.diff(xy, axis=0), axis=1) > max_jump_px))[0] + 1
        pieces = [p for p in np.split(xy, breaks) if len(p) >= 2]
        if pieces:
            paths.append(Path(tid, t, xy, pieces))
    return paths


def analyse(points: list[TrackPoint], sample_fps: float, zones: list[Zone],
            cal: Calibration, mapping: dict[int, str] | None = None, **path_kw) -> Analysis:
    dt = 1.0 / sample_fps
    paths = build_paths(points, sample_fps, mapping, **path_kw)
    a = Analysis(paths=paths, zones=zones, sample_dt=dt)

    for path in paths:
        dist = 0.0
        for piece in path.pieces:
            floor = cal.to_floor(piece)
            if floor is not None:
                dist += float(np.linalg.norm(np.diff(floor, axis=0), axis=1).sum())
        if cal.calibrated:
            a.distance_m[path.operator] = dist
        a.active_s[path.operator] = len(path.t) * dt

    if zones:
        dwell = defaultdict(float)
        flows = defaultdict(int)
        for path in paths:
            last = None
            mine = a.dwell_by_op.setdefault(path.operator, defaultdict(float))
            for x, y in path.xy:
                z = next((z.name for z in zones if z.contains(x, y)), None)
                if z:
                    dwell[z] += dt
                    mine[z] += dt
                    if last and z != last:
                        flows[(last, z)] += 1  # walked from zone `last` to zone `z`
                    last = z
        a.dwell_s, a.flows = dict(dwell), dict(flows)
    return a
