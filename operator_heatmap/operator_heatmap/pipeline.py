"""Video in -> PDF (+ PNGs + CSVs) out. Used by both the CLI and the web app.

Two stages so operator relabelling is instant:
  track()  - slow: detect + track people through the segments, cached to <out_dir>/<stem>_tracks.pkl
  report() - fast: resolve operator identities, analyse, render, write PDF
"""
from __future__ import annotations

import csv
import os
import re
import pickle
from dataclasses import dataclass
from typing import Callable

import cv2

from .analysis import analyse, load_config, resolve_identities, tracklet_table
from .projection import View360
from .report import build_pdf
from .render import draw_legend, render_all, render_operators
from .roi import ROI, edge_distance, preview
from .segments import parse_segments, parse_ts
from .tracker import TrackResult, VideoSource, make_backend, track_video, valid_area


@dataclass
class Options:
    video: str
    out_dir: str = "output"
    title: str = ""
    camera: str = "fixed"            # fixed | fisheye (ceiling 360, circular image) | 360 (equirectangular)
    segments: str = ""               # "00:01:00-00:04:00, 00:10:00-00:12:00"; blank = whole video
    base_time: str = ""              # timestamp of the background photo; blank = median 'empty floor' image
    backend: str = "yolo"            # yolo | motion
    model: str = "yolo11n.pt"        # yolo11s.pt / yolo11m.pt = more accurate, slower
    conf: float = 0.35
    imgsz: int = 960                 # detector input size; 1280 for wide shots with small/distant operators
    sample_fps: float = 5.0
    config: str = ""                 # zones + calibration JSON
    page: str = "A3"
    yaw: float = 0.0                 # 360 only
    pitch: float = -20.0
    fov: float = 100.0
    min_track_s: float = 2.0
    operators: int = 0               # optional: operators working the area; 0 = auto (measured from footage)
    resident_min_s: float = 0.0      # min time in area to count as an operator, else through-traffic; 0 = auto
    stitch_gap_s: float = 15.0       # max hidden time (behind racking etc.) to rejoin a track
    mount_height: float = 0.0        # fisheye: lens height above floor in metres -> metres walked, no targets
    lens_fov: float = 180.0          # fisheye: lens field of view (Hikvision/Axis/Uniview ~180-187)
    lens_model: str = "equidistant"  # fisheye projection: equidistant | equisolid
    fisheye_circle: str = ""         # "cx,cy,r" override if auto-detect misses
    tiles: int = 6                   # fisheye: unwrap tiles (more = smaller people found, slower)
    roi: str = ""                    # area isolation JSON (see roi.py); also read from config["roi"]
    crop_output: bool = True         # zoom the PDF to the selected area


def _stem(o: Options) -> str:
    return os.path.splitext(os.path.basename(o.video))[0]


def roi_spec(o: Options) -> dict | None:
    import json
    if o.roi:
        return json.loads(o.roi) if isinstance(o.roi, str) else o.roi
    if o.config:
        with open(o.config) as fh:
            return json.load(fh).get("roi")
    return None


def track(o: Options, progress: Callable[[float], None] | None = None) -> TrackResult:
    os.makedirs(o.out_dir, exist_ok=True)
    circle = tuple(float(v) for v in o.fisheye_circle.split(",")) if o.fisheye_circle else None
    src = VideoSource(o.video, o.camera, View360(o.yaw, o.pitch, o.fov), circle)
    try:
        segs = parse_segments(o.segments, src.duration)
        base_t = parse_ts(o.base_time) if o.base_time else None
        name = "fisheye" if o.camera == "fisheye" and o.backend == "yolo" else o.backend
        backend = make_backend(name, model=o.model, conf=o.conf, imgsz=o.imgsz, sample_fps=o.sample_fps,
                               n_tiles=o.tiles)
        valid = valid_area(src)  # skip black borders -> faster
        roi = ROI.from_spec(roi_spec(o), src.size, valid)
        tr = track_video(src, segs, backend, o.sample_fps, base_t, progress, roi)
        tr.roi_spec = roi_spec(o)
        tr.valid_png = cv2.imencode(".png", valid)[1].tobytes()
    finally:
        src.close()
    with open(os.path.join(o.out_dir, f"{_stem(o)}_tracks.pkl"), "wb") as fh:
        pickle.dump(tr, fh)
    return tr


def load_tracks(o: Options) -> TrackResult:
    with open(os.path.join(o.out_dir, f"{_stem(o)}_tracks.pkl"), "rb") as fh:
        return pickle.load(fh)


AUTO_NAME = re.compile(r"^(Operator|Through-traffic) \d+$")


def report(o: Options, tr: TrackResult, labels: dict[int, str] | None = None,
           people: list[str] | None = None) -> dict:
    """people: only include these people (e.g. ["Josh"]) -> PDF, images and stats for just them."""
    stem = _stem(o)
    title = o.title or stem
    roi = ROI.from_spec(getattr(tr, "roi_spec", None), tr.view_size, getattr(tr, "valid_mask", None))
    analysed_s = sum(e - s for s, e in tr.segments)
    res_min = o.resident_min_s or min(90.0, 0.4 * max(analysed_s, 1))
    mapping, roles = resolve_identities(
        tr.points, tr.appearance, tr.view_size, n_operators=o.operators or None, labels=labels,
        max_gap_s=o.stitch_gap_s, edge_dist=edge_distance(tr.view_size, roi, tr.camera == "fisheye"),
        analysed_s=analysed_s, resident_min_s=res_min, return_roles=True)
    all_people = sorted(set(mapping.values()))
    full_mapping = dict(mapping)
    full_roles = dict(roles)
    if people:
        roles = dict(roles)
        roles["_passes"] = sum(1 for n in set(people) if roles.get(n) == "through")
        title = f"{title} - {', '.join(people)}"
        stem = f"{stem}_" + re.sub(r"[^A-Za-z0-9]+", "-", "_".join(people)).strip("-")
        mapping = {t: n for t, n in mapping.items() if n in people}
    zones, cal = load_config(o.config or None)
    if tr.camera == "fisheye" and o.mount_height > 0 and not cal.calibrated:
        cal.fisheye = {"R": tr.view_size[0] / 2, "height_m": o.mount_height,
                       "lens_fov_deg": o.lens_fov, "model": o.lens_model}
    a = analyse(tr.points, o.sample_fps, zones, cal, mapping=mapping, roles=roles, analysed_s=analysed_s,
                resident_min_s=res_min, min_seconds=o.min_track_s, max_jump_px=max(tr.view_size) / 8)
    base = preview(tr.base_frame, roi)  # ignored areas dimmed, selection outlined
    imgs = {k: v for k, v in render_all(base, a).items() if v is not None}
    named = [p.operator for p in a.paths if not AUTO_NAME.match(p.operator)]  # anyone you named gets a page
    pages_for = list(people) if people else list(dict.fromkeys(a.main_operators + named))
    op_imgs = render_operators(base, a, [n for n in pages_for if n in {p.operator for p in a.paths}])
    crop = roi.bbox() if roi is not None and o.crop_output else None
    if crop is not None:
        x1, y1, x2, y2 = crop
        imgs = {k: v[y1:y2, x1:x2] for k, v in imgs.items()}
        op_imgs = {k: v[y1:y2, x1:x2] for k, v in op_imgs.items()}
    imgs["spaghetti"] = draw_legend(imgs["spaghetti"], a)

    out: dict = {}
    for k, img in imgs.items():
        out[k] = os.path.join(o.out_dir, f"{stem}_{k}.png")
        cv2.imwrite(out[k], img)
    out["csv"] = os.path.join(o.out_dir, f"{stem}_tracks.csv")
    with open(out["csv"], "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["person", "role", "track_id", "time_s", "foot_x_px", "foot_y_px", "box_w", "box_h"])
        for p in tr.points:
            who = mapping.get(p.track_id, "ignored/noise")
            w.writerow([who, a.roles.get(who, roles.get(who, "")), p.track_id, f"{p.t:.2f}",
                        f"{p.x:.1f}", f"{p.y:.1f}", f"{p.w:.0f}", f"{p.h:.0f}"])
    out["headcount_csv"] = os.path.join(o.out_dir, f"{stem}_headcount.csv")
    with open(out["headcount_csv"], "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["time_s", "people_visible"])
        w.writerows((f"{t:.2f}", n) for t, n in tr.headcount)
    out["pdf"] = os.path.join(o.out_dir, f"{stem}_operator_heatmap.pdf")
    build_pdf(out["pdf"], imgs, a, {"title": title, "video": os.path.basename(o.video), "camera": o.camera,
                                    "segments": tr.segments, "frames": tr.frames_analysed,
                                    "sample_fps": o.sample_fps, "headcount": tr.headcount},
              o.page, op_imgs)
    out["mapping"] = mapping
    out["people"] = all_people
    out["roles"] = full_roles
    out["base"] = base
    out["crop"] = crop
    out["tracklets"] = tracklet_table(tr.points, full_mapping)
    out["analysis"] = a
    return out


def run(o: Options, progress: Callable[[float], None] | None = None,
        labels: dict[int, str] | None = None) -> dict:
    return report(o, track(o, progress), labels)
