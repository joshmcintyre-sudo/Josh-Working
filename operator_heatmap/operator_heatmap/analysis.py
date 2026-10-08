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
                       max_gap_s: float = 15.0, max_app: float = 0.45, min_points: int = 3,
                       edge_dist=None, analysed_s: float | None = None, resident_min_s: float | None = None,
                       return_roles: bool = False):
    """Map raw tracker IDs -> people, and tell resident operators from through-traffic.

    1. Stitch: track B continues track A if B starts after A ends, the jump is walkable in the gap,
       and clothing colours match (occlusion behind racking/pillars, missed detections).
    2. Roles (no headcount needed):
       - resident  = in the area for long (>= resident_min_s, default min(90 s, 40% of analysed time))
       - short track that starts AND ends at the edge of the view / selected area = through-traffic
         (warehouse team, other lines, managers walking through)
       - short track that starts or ends mid-floor = a lost piece of a resident -> rejoined to the
         resident with matching clothes who was not on screen at that moment
       - same-looking residents never on screen together = one person who left and came back
    3. Optional headcount hint: merge residents until N remain.
    4. Manual labels from the app override everything ("ignore" drops a track).
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

    def sig(g):
        hs = [tls[t].hist * tls[t].n for t in g if tls[t].hist is not None]
        return (sum(hs) / (sum(h.sum() for h in hs) + 1e-9)).astype(np.float32) if hs else None

    def overlap(g1, g2):
        return sum(max(0.0, min(tls[a].t1, tls[b].t1) - max(tls[a].t0, tls[b].t0)) for a in g1 for b in g2)

    def span(g):
        return sum(tls[t].t1 - tls[t].t0 for t in g)

    def compatible(g1, g2):  # never both on screen (small allowance for swap-cut lag)
        return overlap(g1, g2) <= max(2.0, 0.05 * min(span(g1), span(g2)))

    # 2. roles
    if analysed_s is None:
        analysed_s = max((t.t1 for t in tls.values()), default=0) - min((t.t0 for t in tls.values()), default=0)
    res_min = resident_min_s if resident_min_s is not None else min(90.0, 0.4 * max(analysed_s, 1))
    edge = edge_dist or (lambda x, y: min(x, y, view_size[0] - x, view_size[1] - y))
    edge_px = 0.10 * diag  # fast walkers are often first picked up a little way in

    def at_edge(g):
        first = min(g, key=lambda t: tls[t].t0)
        last = max(g, key=lambda t: tls[t].t1)
        return edge(*tls[first].p0) <= edge_px and edge(*tls[last].p1) <= edge_px

    residents = [g for g in groups if span(g) >= res_min]
    short = [g for g in groups if span(g) < res_min]
    through, orphans = [], []
    for g in sorted(short, key=span, reverse=True):
        if at_edge(g):
            through.append(g)
            continue
        # lost piece of a resident: best clothing match among residents free at that time
        sg = sig(g)
        cands = [(_app_dist(sig(r), sg), i) for i, r in enumerate(residents) if compatible(r, g)]
        cands = [c for c in cands if c[0] <= 0.5]
        if cands:
            residents[min(cands)[1]] += g
        else:
            orphans.append(g)
    residents += orphans  # mid-floor tracks with no match: keep as their own (short) operator

    def merge_reentries(gs, thresh):
        merged = True
        while merged:
            merged = False
            sigs = [sig(g) for g in gs]
            best = None
            for i in range(len(gs)):
                for j in range(i + 1, len(gs)):
                    if compatible(gs[i], gs[j]):
                        d = _app_dist(sigs[i], sigs[j])
                        if d <= thresh and (best is None or d < best[0]):
                            best = (d, i, j)
            if best:
                _, i, j = best
                gs[i] += gs.pop(j)
                merged = True
        return gs

    passes = len(through)
    residents = merge_reentries(residents, 0.30)
    through = merge_reentries(through, 0.20)  # same visitor walking through again (strict: uniforms look alike)

    # 3. optional headcount hint (residents only)
    if n_operators:
        while len(residents) > n_operators:
            sigs = [sig(g) for g in residents]
            best = None
            for i in range(len(residents)):
                for j in range(i + 1, len(residents)):
                    if not compatible(residents[i], residents[j]):
                        continue
                    d = _app_dist(sigs[i], sigs[j])
                    if best is None or d < best[0]:
                        best = (d, i, j)
            if best is None:
                # extras are duplicate boxes of someone already tracked (person split by a post)
                j = min(range(len(residents)), key=lambda k: span(residents[k]))
                i = min((k for k in range(len(residents)) if k != j),
                        key=lambda k: _app_dist(sigs[k], sigs[j]))
                best = (0, min(i, j), max(i, j))
            _, i, j = best
            residents[i] += residents.pop(j)

    first = lambda g: min(tls[t].t0 for t in g)
    mapping, roles = {}, {"_passes": passes}
    for k, g in enumerate(sorted(residents, key=first)):
        name = f"Operator {k + 1}"
        roles[name] = "operator"
        mapping.update({t: name for t in g})
    for k, g in enumerate(sorted(through, key=first)):
        name = f"Through-traffic {k + 1}"
        roles[name] = "through"
        mapping.update({t: name for t in g})

    # 3. manual overrides
    auto_role = {t: roles.get(n, "operator") for t, n in mapping.items()}
    for tid, name in (labels or {}).items():
        name = (name or "").strip()
        if name:
            mapping[int(tid)] = name
    for name in set(mapping.values()) - set(roles):  # user names inherit the majority auto role
        votes = [auto_role.get(t, "operator") for t, n in mapping.items() if n == name]
        roles[name] = max(set(votes), key=votes.count)
    mapping = {t: n for t, n in mapping.items() if n.lower() != "ignore"}
    return (mapping, roles) if return_roles else mapping


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
    roles: dict[str, str] = field(default_factory=dict)   # person -> "operator" | "through"
    crew: dict[str, float] = field(default_factory=dict)  # operators on screen at once: median / p95 / max
    through: dict[str, float] = field(default_factory=dict)  # passes, passes per hour, avg seconds per pass
    main_operators: list[str] = field(default_factory=list)  # operators present long enough for their own page
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
            cal: Calibration, mapping: dict[int, str] | None = None, roles: dict | None = None,
            analysed_s: float = 0.0, resident_min_s: float = 60.0, **path_kw) -> Analysis:
    dt = 1.0 / sample_fps
    paths = build_paths(points, sample_fps, mapping, **path_kw)
    a = Analysis(paths=paths, zones=zones, sample_dt=dt)
    roles = roles or {}
    a.roles = {p.operator: roles.get(p.operator, "operator") for p in paths}

    # crew size measured from the footage: distinct operators on screen per sampled frame
    on_screen = defaultdict(set)
    for path in paths:
        if a.roles[path.operator] == "operator":
            for t in path.t:
                on_screen[round(t * sample_fps)].add(path.operator)
    counts = np.array([len(v) for v in on_screen.values()]) if on_screen else np.zeros(1)
    a.crew = {"median": float(np.median(counts)), "p95": float(np.percentile(counts, 95)), "max": float(counts.max())}

    thr = [p for p in paths if a.roles[p.operator] == "through"]
    n_pass = roles.get("_passes", len(thr))
    thr_s = sum(len(p.t) * dt for p in thr)
    a.through = {"passes": n_pass, "people": len(thr),
                 "per_hour": n_pass / max(analysed_s / 3600, 1e-9) if analysed_s else 0.0,
                 "avg_s": thr_s / n_pass if n_pass else 0.0, "total_s": thr_s}

    for path in paths:
        dist = 0.0
        for piece in path.pieces:
            floor = cal.to_floor(piece)
            if floor is not None:
                dist += float(np.linalg.norm(np.diff(floor, axis=0), axis=1).sum())
        if cal.calibrated:
            a.distance_m[path.operator] = dist
        a.active_s[path.operator] = len(path.t) * dt
    a.main_operators = [p.operator for p in paths if a.roles[p.operator] == "operator"
                        and a.active_s[p.operator] >= min(resident_min_s, 0.4 * max(analysed_s, 1))]

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
