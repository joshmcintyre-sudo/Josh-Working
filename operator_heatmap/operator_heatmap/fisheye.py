"""Ceiling-mounted 360 fisheye (circular image looking straight down).

Seen from above, every operator "points" away from the image centre (feet in, head out), so a
detector trained on upright people misses most of them. Fix: unwrap the circle into panorama
tiles (outer edge = top) where everyone stands upright, detect there, map the foot point back
onto the circle, and track in circle coordinates.
"""
from __future__ import annotations

import cv2
import numpy as np


def detect_circle(frames: list[np.ndarray]) -> tuple[float, float, float]:
    """Find the fisheye image circle (cx, cy, r) from a few frames (black surround)."""
    mx = np.max(np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]), axis=0)
    mask = cv2.morphologyEx((mx > 18).astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = mx.shape
    if cnts:
        (cx, cy), r = cv2.minEnclosingCircle(max(cnts, key=cv2.contourArea))
        if r > 0.3 * min(w, h):
            return float(cx), float(cy), float(r)
    return w / 2, h / 2, min(w, h) / 2  # full-frame fisheye: assume inscribed circle


def crop_circle(frame: np.ndarray, circle: tuple[float, float, float]) -> np.ndarray:
    """Square crop around the circle (padding if it touches the frame edge)."""
    cx, cy, r = (int(round(v)) for v in circle)
    pad = max(0, r - cx, r - cy, cx + r - frame.shape[1], cy + r - frame.shape[0])
    if pad:
        frame = cv2.copyMakeBorder(frame, pad, pad, pad, pad, cv2.BORDER_CONSTANT)
        cx, cy = cx + pad, cy + pad
    return frame[cy - r:cy + r, cx - r:cx + r]


class Unwrapper:
    """Circle (already cropped: centre = (R, R)) -> n upright panorama tiles, and back."""

    def __init__(self, R: float, n_tiles: int = 6, overlap_deg: float = 15, r_min_frac: float = 0.06):
        self.R, self.n = R, n_tiles
        self.core = 2 * np.pi / n_tiles
        self.span = self.core + 2 * np.radians(overlap_deg)
        self.r_min = r_min_frac * R
        self.th = int(R - self.r_min)                              # 1 px per radial px
        self.tw = int(2 * np.pi * 0.6 * R * self.span / (2 * np.pi))  # true scale at 60% radius
        u, v = np.meshgrid(np.arange(self.tw, dtype=np.float32), np.arange(self.th, dtype=np.float32))
        r = R - v * (R - self.r_min) / self.th
        self.maps = []
        for k in range(n_tiles):
            phi = k * self.core + (u / self.tw - 0.5) * self.span
            self.maps.append(((R + r * np.cos(phi)).astype(np.float32), (R + r * np.sin(phi)).astype(np.float32)))

    def tiles(self, frame: np.ndarray) -> list[np.ndarray]:
        return [cv2.remap(frame, mx, my, cv2.INTER_LINEAR) for mx, my in self.maps]

    def to_circle(self, k: int, u: float, v: float) -> tuple[float, float, float]:
        """Tile pixel -> (x, y) on the circle image + angle offset from the tile centre."""
        off = (u / self.tw - 0.5) * self.span
        phi = k * self.core + off
        r = self.R - min(max(v, 0), self.th) * (self.R - self.r_min) / self.th
        return self.R + r * np.cos(phi), self.R + r * np.sin(phi), off


def colour_hist(crop: np.ndarray) -> np.ndarray | None:
    if crop is None or crop.size == 0 or crop.shape[0] < 20 or crop.shape[1] < 8:
        return None
    ch = crop.shape[0]
    hsv = cv2.cvtColor(crop[int(ch * 0.15):int(ch * 0.85)], cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256]).flatten()
    return (h / (h.sum() + 1e-9)).astype(np.float32)


class SimpleTracker:
    """Constant-velocity + clothing-colour tracker with optimal (Hungarian/LAPJV) matching."""

    def __init__(self, gate_px: float, lost_frames: int, new_conf: float = 0.45):
        self.gate, self.lost_frames, self.new_conf = gate_px, lost_frames, new_conf
        self.reset()

    def reset(self):
        self.tracks: dict[int, dict] = {}
        self.next_id = getattr(self, "next_id", 1)

    def update(self, dets: list[dict]) -> list[tuple[int, dict]]:
        import lap
        ids = list(self.tracks)
        out = []
        matched_t, matched_d = set(), set()
        if ids and dets:
            C = np.full((len(ids), len(dets)), 1e6)
            for i, tid in enumerate(ids):
                t = self.tracks[tid]
                pred = t["pos"] + t["vel"] * (1 + t["lost"])
                gate = self.gate * (1 + 0.5 * t["lost"])  # search wider the longer they are hidden
                for j, d in enumerate(dets):
                    dist = float(np.linalg.norm(d["pos"] - pred))
                    if dist > gate:
                        continue
                    app = 0.5 if t["hist"] is None or d["hist"] is None else \
                        cv2.compareHist(t["hist"], d["hist"], cv2.HISTCMP_BHATTACHARYYA)
                    if app <= 0.6:
                        C[i, j] = dist / gate + 0.7 * app
            _, x, _ = lap.lapjv(C, extend_cost=True, cost_limit=1.5)
            for i, j in enumerate(x):
                if j < 0 or C[i, j] >= 1e6:
                    continue
                tid, d = ids[i], dets[j]
                t = self.tracks[tid]
                t["vel"] = 0.6 * t["vel"] + 0.4 * (d["pos"] - t["pos"]) / (1 + t["lost"])
                t["pos"], t["lost"] = d["pos"], 0
                if d["hist"] is not None:
                    t["hist"] = d["hist"] if t["hist"] is None else (0.8 * t["hist"] + 0.2 * d["hist"]).astype(np.float32)
                matched_t.add(tid)
                matched_d.add(j)
                out.append((tid, d))
        for tid in ids:
            if tid not in matched_t:
                self.tracks[tid]["lost"] += 1
                if self.tracks[tid]["lost"] > self.lost_frames:
                    del self.tracks[tid]
        for j, d in enumerate(dets):
            if j not in matched_d and d["conf"] >= self.new_conf:
                self.tracks[self.next_id] = {"pos": d["pos"], "vel": np.zeros(2), "hist": d["hist"], "lost": 0}
                out.append((self.next_id, d))
                self.next_id += 1
        return out


class FisheyeBackend:
    """YOLO on unwrapped tiles -> foot points on the circle -> SimpleTracker."""

    needs_full_frame = True

    def __init__(self, model: str = "yolo11n.pt", conf: float = 0.2, device: str | None = None,
                 sample_fps: float = 5.0, lost_s: float = 8.0, imgsz: int = 960, n_tiles: int = 6):
        from ultralytics import YOLO
        self.model = YOLO(model)
        self.conf, self.device, self.imgsz, self.n_tiles = conf, device, imgsz, n_tiles
        self.sample_fps, self.lost_s = sample_fps, lost_s
        self.unwrap: Unwrapper | None = None
        self.tracker: SimpleTracker | None = None
        self.roi_mask: np.ndarray | None = None
        self.active: list[tuple[int, int, int]] = []  # (tile, first row, last row) actually processed

    def set_roi(self, mask: np.ndarray):
        self.roi_mask = mask
        self.unwrap = None  # rebuild active tiles on next frame

    def _plan_tiles(self):
        """Only unwrap tiles (and rows) that see the selected area -> big speed-up for small selections."""
        u = self.unwrap
        self.active = []
        for k, (mx, my) in enumerate(u.maps):
            if self.roi_mask is None:
                self.active.append((k, 0, u.th))
                continue
            cov = cv2.remap(self.roi_mask, mx, my, cv2.INTER_NEAREST) > 0
            rows = np.nonzero(cov.any(axis=1))[0]
            if not len(rows):
                continue
            head = int(0.3 * u.th)  # feet in the area, body extends outward (= up in the tile)
            self.active.append((k, max(0, rows[0] - head), min(u.th, rows[-1] + 20)))

    def reset(self):
        if self.tracker:
            self.tracker.reset()

    def __call__(self, frame: np.ndarray):
        R = frame.shape[0] / 2
        if self.unwrap is None or abs(self.unwrap.R - R) > 1:
            self.unwrap = Unwrapper(R, self.n_tiles)
            # ~1.5 m/s walking; at a typical 5-8 m mount, 1 m on the floor ~ 0.1 R near the centre
            self.tracker = SimpleTracker(gate_px=0.45 * R / self.sample_fps,
                                         lost_frames=int(self.lost_s * self.sample_fps))
            self._plan_tiles()
        if not self.active:
            return []
        u = self.unwrap
        tiles = [cv2.remap(frame, u.maps[k][0][a:b], u.maps[k][1][a:b], cv2.INTER_LINEAR) for k, a, b in self.active]
        imgsz = min(self.imgsz, 32 * int(np.ceil(max(u.tw, max(b - a for _, a, b in self.active)) / 32)))
        results = self.model.predict(tiles, classes=[0], conf=self.conf, imgsz=imgsz,
                                     verbose=False, device=self.device)
        dets = []
        half_core = u.core / 2
        for (k, a, _), tile, res in zip(self.active, tiles, results):
            if res.boxes is None:
                continue
            for (x1, y1, x2, y2), c in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.conf.cpu().numpy()):
                fx, fy, off = u.to_circle(k, (x1 + x2) / 2, y2 + a)
                if abs(off) > half_core:
                    continue  # this person is owned by the neighbouring tile -> no duplicates
                crop = tile[int(max(0, y1)):int(y2), int(max(0, x1)):int(x2)]
                dets.append({"pos": np.array([fx, fy]), "conf": float(c), "hist": colour_hist(crop),
                             "crop": crop, "wh": (x2 - x1, y2 - y1)})
        return [(tid, d["pos"][0], d["pos"][1], d["wh"][0], d["wh"][1], d["crop"])
                for tid, d in self.tracker.update(dets)]


def floor_metres(pts: np.ndarray, R: float, height_m: float, lens_fov_deg: float = 180.0,
                 model: str = "equidistant") -> np.ndarray:
    """Circle pixels -> floor metres from the point under the camera (no calibration targets needed)."""
    d = pts - R
    rn = np.clip(np.linalg.norm(d, axis=1) / R, 0, 1)
    half = np.radians(lens_fov_deg) / 2
    if model == "equisolid":
        theta = 2 * np.arcsin(np.clip(rn * np.sin(half / 2), -1, 1))
    else:
        theta = rn * half
    ground = height_m * np.tan(np.minimum(theta, np.radians(80)))  # clamp near the horizon
    phi = np.arctan2(d[:, 1], d[:, 0])
    return np.stack([ground * np.cos(phi), ground * np.sin(phi)], axis=1)
