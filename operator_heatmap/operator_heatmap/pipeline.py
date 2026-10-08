"""One call: video in -> PDF (+ PNGs + CSV) out. Used by both the CLI and the web app."""
from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from typing import Callable

import cv2

from .analysis import analyse, load_config
from .projection import View360
from .report import build_pdf
from .render import render_all
from .segments import parse_segments, parse_ts
from .tracker import VideoSource, make_backend, track_video


@dataclass
class Options:
    video: str
    out_dir: str = "output"
    title: str = ""
    camera: str = "fixed"            # fixed | 360
    segments: str = ""               # "00:01:00-00:04:00, 00:10:00-00:12:00"; blank = whole video
    base_time: str = ""              # timestamp of the background photo; blank = median 'empty floor' image
    backend: str = "yolo"            # yolo | motion
    model: str = "yolo11n.pt"        # yolo11s.pt / yolo11m.pt = more accurate, slower
    conf: float = 0.35
    sample_fps: float = 5.0
    config: str = ""                 # zones + calibration JSON
    page: str = "A3"
    yaw: float = 0.0                 # 360 only
    pitch: float = -20.0
    fov: float = 100.0
    min_track_s: float = 2.0


def run(o: Options, progress: Callable[[float], None] | None = None) -> dict[str, str]:
    os.makedirs(o.out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(o.video))[0]
    title = o.title or stem
    src = VideoSource(o.video, o.camera, View360(o.yaw, o.pitch, o.fov))
    try:
        segs = parse_segments(o.segments, src.duration)
        base_t = parse_ts(o.base_time) if o.base_time else None
        backend = make_backend(o.backend, model=o.model, conf=o.conf)
        tr = track_video(src, segs, backend, o.sample_fps, base_t, progress)
    finally:
        src.close()

    zones, cal = load_config(o.config or None)
    a = analyse(tr.points, o.sample_fps, zones, cal, min_seconds=o.min_track_s,
                max_jump_px=max(tr.view_size) / 8)
    imgs = render_all(tr.base_frame, a)

    out = {}
    for k, img in imgs.items():
        out[k] = os.path.join(o.out_dir, f"{stem}_{k}.png")
        cv2.imwrite(out[k], img)
    out["csv"] = os.path.join(o.out_dir, f"{stem}_tracks.csv")
    with open(out["csv"], "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["track_id", "time_s", "foot_x_px", "foot_y_px", "box_w", "box_h"])
        for p in tr.points:
            w.writerow([p.track_id, f"{p.t:.2f}", f"{p.x:.1f}", f"{p.y:.1f}", f"{p.w:.0f}", f"{p.h:.0f}"])
    out["pdf"] = os.path.join(o.out_dir, f"{stem}_operator_heatmap.pdf")
    build_pdf(out["pdf"], imgs, a, {"title": title, "video": os.path.basename(o.video), "camera": o.camera,
                                    "segments": segs, "frames": tr.frames_analysed,
                                    "sample_fps": o.sample_fps}, o.page)
    return out
