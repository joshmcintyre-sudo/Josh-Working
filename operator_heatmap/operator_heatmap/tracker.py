"""Detect + track operators through selected video segments.

Backends
  yolo   - Ultralytics YOLO person detector + ByteTrack IDs (accurate, needs ultralytics/torch)
  motion - OpenCV background subtraction + centroid tracker (no ML, fast, OK for quiet cells)

Each detection is reduced to the operator's *foot point* (bottom-centre of the
box), which is where they stand on the floor -> what the spaghetti diagram needs.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterator

import cv2
import numpy as np

from .projection import EquirectDewarper, View360


@dataclass
class TrackPoint:
    track_id: int
    t: float      # seconds into the source video
    x: float      # foot point, pixels in the analysed view
    y: float
    w: float = 0  # box size (used for filtering)
    h: float = 0


@dataclass
class TrackResult:
    points: list[TrackPoint] = field(default_factory=list)
    base_frame: np.ndarray | None = None
    fps_sampled: float = 0.0
    frames_analysed: int = 0
    segments: list[tuple[float, float]] = field(default_factory=list)
    view_size: tuple[int, int] = (0, 0)  # (w, h)


class VideoSource:
    """Wraps cv2.VideoCapture, optionally dewarping 360 footage."""

    def __init__(self, path: str, camera: str = "fixed", view: View360 | None = None):
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise IOError(f"Cannot open video: {path}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
        self.n_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.duration = self.n_frames / self.fps
        src_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        src_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.dewarp = EquirectDewarper(src_w, src_h, view or View360()) if camera == "360" else None
        self.size = (view.width, view.height) if self.dewarp else (src_w, src_h)

    def frame_at(self, t: float) -> np.ndarray:
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * self.fps))
        ok, frame = self.cap.read()
        if not ok:
            raise IOError(f"Cannot read frame at {t:.1f}s")
        return self.dewarp(frame) if self.dewarp else frame

    def iter_segment(self, start: float, end: float, sample_fps: float) -> Iterator[tuple[float, np.ndarray]]:
        step = max(1, int(round(self.fps / sample_fps)))
        f0, f1 = int(start * self.fps), int(end * self.fps)
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
        for idx in range(f0, f1):
            if (idx - f0) % step:
                if not self.cap.grab():   # skip decode for unsampled frames
                    return
                continue
            ok, frame = self.cap.read()
            if not ok:
                return
            yield idx / self.fps, (self.dewarp(frame) if self.dewarp else frame)

    def close(self):
        self.cap.release()


# --------------------------------------------------------------------------- backends

class YoloBackend:
    def __init__(self, model: str = "yolo11n.pt", conf: float = 0.35, device: str | None = None):
        from ultralytics import YOLO  # lazy: only needed for this backend
        self.model = YOLO(model)
        self.conf = conf
        self.device = device

    def reset(self):
        pred = getattr(self.model, "predictor", None)
        for trk in getattr(pred, "trackers", None) or []:
            trk.reset()

    def __call__(self, frame: np.ndarray) -> list[tuple[int, float, float, float, float]]:
        res = self.model.track(frame, persist=True, classes=[0], conf=self.conf,
                               tracker="bytetrack.yaml", verbose=False, device=self.device)[0]
        if res.boxes is None or res.boxes.id is None:
            return []
        out = []
        for (x1, y1, x2, y2), tid in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.id.int().cpu().numpy()):
            out.append((int(tid), (x1 + x2) / 2, y2, x2 - x1, y2 - y1))
        return out


class MotionBackend:
    """MOG2 foreground blobs + greedy nearest-neighbour tracking."""

    def __init__(self, min_area: int = 1500, max_jump: float = 120, max_age: int = 10):
        self.min_area, self.max_jump, self.max_age = min_area, max_jump, max_age
        self.reset()

    def reset(self):
        self.bg = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=32, detectShadows=True)
        self.tracks: dict[int, tuple[float, float, int]] = {}  # id -> (x, y, age)
        self.next_id = getattr(self, "next_id", 1)

    def __call__(self, frame: np.ndarray):
        mask = self.bg.apply(frame)
        mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)[1]  # drop shadows (127)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        mask = cv2.dilate(mask, np.ones((15, 15), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        dets = []
        for c in contours:
            if cv2.contourArea(c) < self.min_area:
                continue
            x, y, w, h = cv2.boundingRect(c)
            dets.append((x + w / 2, y + h, w, h))

        out, used = [], set()
        for tid, (tx, ty, age) in sorted(self.tracks.items(), key=lambda kv: kv[1][2]):
            best, best_d = None, self.max_jump
            for i, (dx, dy, _, _) in enumerate(dets):
                d = np.hypot(dx - tx, dy - ty)
                if i not in used and d < best_d:
                    best, best_d = i, d
            if best is None:
                self.tracks[tid] = (tx, ty, age + 1)
            else:
                used.add(best)
                dx, dy, w, h = dets[best]
                self.tracks[tid] = (dx, dy, 0)
                out.append((tid, dx, dy, w, h))
        for i, (dx, dy, w, h) in enumerate(dets):
            if i not in used:
                self.tracks[self.next_id] = (dx, dy, 0)
                out.append((self.next_id, dx, dy, w, h))
                self.next_id += 1
        self.tracks = {k: v for k, v in self.tracks.items() if v[2] <= self.max_age}
        return out


def make_backend(name: str, **kw):
    if name == "yolo":
        return YoloBackend(**{k: v for k, v in kw.items() if k in ("model", "conf", "device")})
    if name == "motion":
        return MotionBackend(**{k: v for k, v in kw.items() if k in ("min_area",)})
    raise ValueError(f"Unknown backend '{name}' (use yolo or motion)")


# --------------------------------------------------------------------------- main loop

def empty_floor(source: VideoSource, segments: list[tuple[float, float]], n: int = 31) -> np.ndarray:
    """Median of frames spread over the segments -> background photo with operators removed."""
    total = sum(e - s for s, e in segments)
    frames = []
    for k in range(n):
        t = (k + 0.5) / n * total
        for s, e in segments:
            if t <= e - s:
                frames.append(source.frame_at(s + t))
                break
            t -= e - s
    return np.median(np.stack(frames), axis=0).astype(np.uint8)


def track_video(source: VideoSource, segments: list[tuple[float, float]], backend,
                sample_fps: float = 5.0, base_time: float | None = None,
                progress: Callable[[float], None] | None = None) -> TrackResult:
    res = TrackResult(segments=segments, fps_sampled=sample_fps, view_size=source.size)
    total = sum(e - s for s, e in segments) or 1
    done = 0.0
    id_offset = 0
    for s, e in segments:
        backend.reset()
        max_id = 0
        for t, frame in source.iter_segment(s, e, sample_fps):
            for tid, x, y, w, h in backend(frame):
                res.points.append(TrackPoint(tid + id_offset, t, x, y, w, h))
                max_id = max(max_id, tid)
            res.frames_analysed += 1
            if progress:
                progress(min(1.0, (done + t - s) / total))
        done += e - s
        id_offset += max_id + 1  # IDs never collide across segments
    res.base_frame = source.frame_at(base_time) if base_time is not None else empty_floor(source, segments)
    if progress:
        progress(1.0)
    return res
