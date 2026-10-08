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

    def to_floor(self, pts: np.ndarray) -> np.ndarray | None:
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


@dataclass
class Path:
    track_id: int
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
    distance_m: dict[int, float] = field(default_factory=dict)
    sample_dt: float = 0.2


def build_paths(points: list[TrackPoint], sample_fps: float, min_seconds: float = 2.0,
                max_gap_s: float = 2.0, max_jump_px: float = 200, smooth: int = 3) -> list[Path]:
    by_id: dict[int, list[TrackPoint]] = defaultdict(list)
    for p in points:
        by_id[p.track_id].append(p)
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
            cal: Calibration, **path_kw) -> Analysis:
    dt = 1.0 / sample_fps
    paths = build_paths(points, sample_fps, **path_kw)
    a = Analysis(paths=paths, zones=zones, sample_dt=dt)

    for path in paths:
        dist = 0.0
        for piece in path.pieces:
            floor = cal.to_floor(piece)
            if floor is not None:
                dist += float(np.linalg.norm(np.diff(floor, axis=0), axis=1).sum())
        if cal.H is not None or cal.px_per_m:
            a.distance_m[path.track_id] = dist

    if zones:
        dwell = defaultdict(float)
        flows = defaultdict(int)
        for path in paths:
            last = None
            for x, y in path.xy:
                z = next((z.name for z in zones if z.contains(x, y)), None)
                if z:
                    dwell[z] += dt
                    if last and z != last:
                        flows[(last, z)] += 1  # walked from zone `last` to zone `z`
                    last = z
        a.dwell_s, a.flows = dict(dwell), dict(flows)
    return a
