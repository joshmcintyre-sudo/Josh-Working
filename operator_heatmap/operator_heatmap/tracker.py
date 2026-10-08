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

from .fisheye import FisheyeBackend, crop_circle, detect_circle
from .projection import EquirectDewarper, View360


@dataclass
class TrackPoint:
    track_id: int
    t: float      # seconds into the source video
    x: float      # foot point, pixels in the analysed view
    y: float
    w: float = 0  # box size (used for filtering)
    h: float = 0
    hist: np.ndarray | None = None  # clothing colour of this detection (dropped after ID-swap check)


@dataclass
class TrackResult:
    points: list[TrackPoint] = field(default_factory=list)
    base_frame: np.ndarray | None = None
    fps_sampled: float = 0.0
    frames_analysed: int = 0
    segments: list[tuple[float, float]] = field(default_factory=list)
    view_size: tuple[int, int] = (0, 0)  # (w, h)
    camera: str = "fixed"
    roi_spec: dict | None = None  # area isolation used for this run
    appearance: dict[int, np.ndarray] = field(default_factory=dict)  # track -> mean clothing colour histogram
    thumbs: dict[int, np.ndarray] = field(default_factory=dict)      # track -> best crop (BGR) for relabelling
    snapshots: dict[int, dict] = field(default_factory=dict)         # track -> {3 s slot: (t, area, crop)}
    headcount: list[tuple[float, int]] = field(default_factory=list)  # (t, people visible)


class VideoSource:
    """Wraps cv2.VideoCapture, optionally dewarping 360 footage."""

    def __init__(self, path: str, camera: str = "fixed", view: View360 | None = None,
                 circle: tuple[float, float, float] | None = None):
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise IOError(f"Cannot open video: {path}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
        self.n_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.duration = self.n_frames / self.fps
        src_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        src_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.camera = camera
        self.dewarp = None
        self.size = (src_w, src_h)
        if camera == "360":
            view = view or View360()
            self.dewarp = EquirectDewarper(src_w, src_h, view)
            self.size = (view.width, view.height)
        elif camera == "fisheye":
            self.circle = circle or detect_circle(self._sample_raw(8))
            self.dewarp = lambda f: crop_circle(f, self.circle)
            d = 2 * int(round(self.circle[2]))
            self.size = (d, d)

    def _sample_raw(self, n: int) -> list[np.ndarray]:
        out = []
        for k in range(n):
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, int((k + 0.5) / n * max(self.n_frames - 1, 1)))
            ok, f = self.cap.read()
            if ok:
                out.append(f)
        if not out:
            raise IOError("Cannot read frames to locate the fisheye circle")
        return out

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

TRACKER_YAML = """tracker_type: {kind}
track_high_thresh: 0.25
track_low_thresh: 0.1
new_track_thresh: 0.4
track_buffer: {buffer}
match_thresh: 0.8
fuse_score: True
gmc_method: none
proximity_thresh: 0.5
appearance_thresh: 0.75
with_reid: {reid}
model: auto
"""


class YoloBackend:
    """YOLO person detector + BoT-SORT with ReID (appearance) so crossing operators keep their own ID."""

    def __init__(self, model: str = "yolo11n.pt", conf: float = 0.35, device: str | None = None,
                 sample_fps: float = 5.0, lost_s: float = 8.0, imgsz: int = 960, tracker: str = "botsort"):
        import tempfile
        from ultralytics import YOLO  # lazy: only needed for this backend
        self.model = YOLO(model)
        self.conf, self.device, self.imgsz = conf, device, imgsz
        fd, self.tracker_cfg = tempfile.mkstemp(suffix=".yaml")
        with open(fd, "w") as fh:  # keep lost tracks alive `lost_s` seconds -> survives pillars, forklifts
            fh.write(TRACKER_YAML.format(kind=tracker, buffer=max(30, int(lost_s * sample_fps)),
                                         reid=tracker == "botsort"))

    def reset(self):
        pred = getattr(self.model, "predictor", None)
        for trk in getattr(pred, "trackers", None) or []:
            trk.reset()

    def __call__(self, frame: np.ndarray) -> list[tuple[int, float, float, float, float]]:
        res = self.model.track(frame, persist=True, classes=[0], conf=self.conf, imgsz=self.imgsz,
                               tracker=self.tracker_cfg, verbose=False, device=self.device)[0]
        if res.boxes is None or res.boxes.id is None:
            return []
        out = []
        for (x1, y1, x2, y2), tid in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.id.int().cpu().numpy()):
            out.append((int(tid), (x1 + x2) / 2, y2, x2 - x1, y2 - y1))
        return out


class MotionBackend:
    """MOG2 foreground blobs + greedy nearest-neighbour tracking."""

    def __init__(self, min_area: int = 1500, max_jump: float = 120, sample_fps: float = 5.0, lost_s: float = 8.0):
        self.min_area, self.max_jump, self.max_age = min_area, max_jump, int(lost_s * sample_fps)
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
            n = max(1, round(w / (0.5 * h)))  # a standing person is ~2x taller than wide
            for i in range(n):              # wide blob = operators shoulder to shoulder
                dets.append((x + (i + 0.5) * w / n, y + h, w / n, h))

        out, used = [], set()
        for tid, (tx, ty, age) in sorted(self.tracks.items(), key=lambda kv: kv[1][2]):
            best, best_d = None, self.max_jump * (1 + 0.25 * age)  # widen search while hidden
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
        keep = ("model", "conf", "device", "sample_fps", "lost_s", "imgsz", "tracker")
        return YoloBackend(**{k: v for k, v in kw.items() if k in keep})
    if name == "motion":
        return MotionBackend(**{k: v for k, v in kw.items() if k in ("min_area", "sample_fps", "lost_s")})
    if name == "fisheye":
        keep = ("model", "conf", "device", "sample_fps", "lost_s", "imgsz", "n_tiles")
        return FisheyeBackend(**{k: v for k, v in kw.items() if k in keep})
    raise ValueError(f"Unknown backend '{name}' (use yolo, fisheye or motion)")


# --------------------------------------------------------------------------- main loop

def _crop(frame, x, y, w, h):
    H, W = frame.shape[:2]
    x1, x2 = int(max(0, x - w / 2)), int(min(W, x + w / 2))
    y1, y2 = int(max(0, y - h)), int(min(H, y))
    return frame[y1:y2, x1:x2]


def _update_appearance(res: TrackResult, tid: int, crop: np.ndarray, t: float = 0.0):
    """Colour signature (hi-vis vest, shirt, pants) of one detection + keep the biggest crop as thumbnail."""
    if crop is None or crop.size == 0 or crop.shape[0] < 20 or crop.shape[1] < 8:
        return None
    ch = crop.shape[0]
    body = crop[int(ch * 0.15):int(ch * 0.85)]  # skip head / floor
    hsv = cv2.cvtColor(body, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256]).flatten()
    hist /= hist.sum() + 1e-9
    # one snapshot candidate per 3 s window (biggest view of the person) -> right thumbnail after splits
    snaps = res.snapshots.setdefault(tid, {})
    slot = int(t // 3)
    area = crop.shape[0] * crop.shape[1]
    if slot not in snaps or area > snaps[slot][1]:
        snaps[slot] = (t, area, cv2.resize(crop, (max(1, int(crop.shape[1] * 160 / ch)), 160)))
    return hist.astype(np.float32)


def split_id_switches(res: TrackResult, window: int = 5, thresh: float = 0.35):
    """Two operators crossing can make the tracker swap IDs. Detect a sudden clothing-colour change
    inside one track and split it there, so each piece belongs to one person."""
    by_id: dict[int, list[TrackPoint]] = {}
    for p in res.points:
        by_id.setdefault(p.track_id, []).append(p)
    next_id = max(by_id, default=0) + 1
    for tid, pts in by_id.items():
        pts.sort(key=lambda p: p.t)
        idx = [i for i, p in enumerate(pts) if p.hist is not None]
        if len(idx) < 2 * window + 2:
            continue
        H = np.stack([pts[i].hist for i in idx])
        cuts, last = [], 0
        k = window
        while k <= len(idx) - window:
            before, after = H[max(last, k - window):k].mean(0), H[k:k + window].mean(0)
            d = cv2.compareHist(before.astype(np.float32), after.astype(np.float32), cv2.HISTCMP_BHATTACHARYYA)
            if d > thresh:
                cuts.append(idx[k])
                last, k = k, k + window
            else:
                k += 1
        snaps = res.snapshots.pop(tid, {})
        bounds = [0] + cuts + [len(pts)]
        for n, (a, b) in enumerate(zip(bounds, bounds[1:])):
            new = tid if n == 0 else next_id
            for p in pts[a:b]:
                p.track_id = new
            t0, t1 = pts[a].t, pts[b - 1].t
            res.snapshots[new] = {k: v for k, v in snaps.items() if t0 <= v[0] <= t1}
            if n:
                next_id += 1
    res.thumbs = {tid: max(sn.values(), key=lambda v: v[1])[2] for tid, sn in res.snapshots.items() if sn}
    res.snapshots = {}  # keep the cache small
    res.appearance = {}
    for p in res.points:
        if p.hist is not None:
            res.appearance[p.track_id] = res.appearance.get(p.track_id, 0) + p.hist
        p.hist = None  # keep the cache small


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
                progress: Callable[[float], None] | None = None, roi=None) -> TrackResult:
    res = TrackResult(segments=segments, fps_sampled=sample_fps, view_size=source.size, camera=source.camera)
    full_frame = getattr(backend, "needs_full_frame", False)  # fisheye geometry needs the whole circle
    if roi is not None:
        if full_frame:
            backend.set_roi(roi.mask)
        x0, y0, x1, y1 = (0, 0, *source.size) if full_frame else roi.bbox()
        m3 = roi.mask[y0:y1, x0:x1, None] > 0
    total = sum(e - s for s, e in segments) or 1
    done = 0.0
    id_offset = 0
    for s, e in segments:
        backend.reset()
        max_id = 0
        for t, frame in source.iter_segment(s, e, sample_fps):
            if roi is not None:  # black out ignored areas + crop to the selection -> fewer pixels to process
                frame = np.where(m3, frame[y0:y1, x0:x1], 0).astype(np.uint8)
            dets = backend(frame)
            kept = 0
            for d in dets:
                tid, x, y, w, h = d[:5]
                crop = d[5] if len(d) > 5 else _crop(frame, x, y, w, h)  # fisheye passes an upright crop
                if roi is not None:
                    x, y = x + x0, y + y0
                    if not roi.contains(x, y):
                        continue  # feet outside the selected area
                kept += 1
                gid = tid + id_offset
                res.points.append(TrackPoint(gid, t, x, y, w, h, _update_appearance(res, gid, crop, t)))
                max_id = max(max_id, tid)
            res.headcount.append((t, kept))
            res.frames_analysed += 1
            if progress:
                progress(min(1.0, (done + t - s) / total))
        done += e - s
        id_offset += max_id + 1  # IDs never collide across segments
    split_id_switches(res)
    res.base_frame = source.frame_at(base_time) if base_time is not None else empty_floor(source, segments)
    if progress:
        progress(1.0)
    return res
