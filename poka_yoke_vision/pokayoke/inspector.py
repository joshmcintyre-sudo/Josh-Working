"""Vision engine: align live frame to the taught reference, then check every labelled region.

Classic OpenCV only (ORB + homography, LAB colour difference, foreground area) so it runs
on an office PC CPU at 1-5 fps with no GPU and no model training.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import cv2
import numpy as np

from . import colour, lighting
from .board import Board, Component

SOMETHING = 14.0  # low difference level: "is ANY object in this pocket?" (catches wrong-colour parts)
PATCH = 24  # presence patches are shrunk to <= 24 px: tolerant to small part shifts / wrinkles


# ---------------------------------------------------------------- helpers
def _lab(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)


def _crop(img: np.ndarray, roi) -> np.ndarray:
    x, y, w, h = roi
    H, W = img.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    return img[y0:y1, x0:x1]


def _small(patch: np.ndarray) -> np.ndarray:
    h, w = patch.shape[:2]
    s = PATCH / max(h, w)
    size = (max(2, round(w * s)), max(2, round(h * s)))
    return _lab(cv2.resize(cv2.GaussianBlur(patch, (5, 5), 0), size, interpolation=cv2.INTER_AREA))


def _patch_dist(a: np.ndarray, b: np.ndarray) -> float:
    """0 = identical. LAB mean abs diff (colour weighted x2) + histogram distance."""
    la, lb = _small(a), _small(b)
    d = np.abs(la - lb)
    pix = (d[..., 0].mean() + 2 * d[..., 1].mean() + 2 * d[..., 2].mean()) / (5 * 255)
    ha = cv2.calcHist([cv2.cvtColor(a, cv2.COLOR_BGR2HSV)], [0, 1], None, [16, 8], [0, 180, 0, 256])
    hb = cv2.calcHist([cv2.cvtColor(b, cv2.COLOR_BGR2HSV)], [0, 1], None, [16, 8], [0, 180, 0, 256])
    cv2.normalize(ha, ha); cv2.normalize(hb, hb)
    hist = cv2.compareHist(ha, hb, cv2.HISTCMP_BHATTACHARYYA)
    return float(0.7 * pix * 4 + 0.3 * hist)  # pix scaled so both terms are ~0..1



def _fg_mask(live: np.ndarray, empty: np.ndarray, level: float) -> np.ndarray:
    d = np.abs(_lab(cv2.GaussianBlur(live, (5, 5), 0)) - _lab(cv2.GaussianBlur(empty, (5, 5), 0)))
    diff = np.maximum(d[..., 0] * 0.5, np.maximum(d[..., 1], d[..., 2]) * 1.5)
    mask = (diff > level).astype(np.uint8) * 255
    k = np.ones((3, 3), np.uint8)
    return cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k)


# ---------------------------------------------------------------- alignment
class Aligner:
    def __init__(self, ref: np.ndarray, n_features: int = 3000):
        self.shape = ref.shape[:2]
        self.orb = cv2.ORB_create(n_features)
        self.kp, self.des = self.orb.detectAndCompute(lighting.clahe_gray(ref), None)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

    def align(self, frame: np.ndarray):
        """Return (warped_frame_in_ref_coords | None, match_score 0..1, homography | None)."""
        if self.des is None or len(self.kp) < 20:
            return None, 0.0, None
        kp, des = self.orb.detectAndCompute(lighting.clahe_gray(frame), None)
        if des is None or len(kp) < 20:
            return None, 0.0, None
        pairs = self.matcher.knnMatch(des, self.des, k=2)
        good = [m for m, *n in pairs if n and m.distance < 0.75 * n[0].distance]
        if len(good) < 12:
            return None, 0.0, None
        src = np.float32([kp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([self.kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if H is None:
            return None, 0.0, None
        det = np.linalg.det(H[:2, :2])
        if not 0.3 < det < 3.0:  # degenerate / mirrored / wildly scaled -> not this board
            return None, 0.0, None
        inl = int(mask.sum())
        score = (inl / len(good)) * min(1.0, inl / 40)
        h, w = self.shape
        return cv2.warpPerspective(frame, H, (w, h)), float(score), H


# ---------------------------------------------------------------- results
@dataclass
class ComponentResult:
    id: str
    label: str
    part_number: str
    expected: int
    found: int
    status: str        # OK | MISSING | SHORT | EXTRA | WRONG_PART (wrong colour/material) | GLARE (can't be seen)
    score: float
    message: str
    roi: list[int]
    variant: str | None = None   # which allowed variant was seen when it isn't the usual one (e.g. "white")


@dataclass
class InspectionResult:
    board_id: str
    board_ok: bool
    match_score: float
    passed: bool
    components: list[ComponentResult]
    message: str
    lighting_ok: bool = True        # False = image not fit to judge (too dark, glare, covered lens)
    lighting: dict | None = None    # brightness / clipped / relative-to-reference measurements

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def problems(self) -> list[ComponentResult]:
        return [c for c in self.components if c.status != "OK"]


def component_status(c: Component, found: int, score: float) -> ComponentResult:
    exp = c.expected_count
    pn = f" ({c.part_number})" if c.part_number else ""
    if found == exp:
        st, msg = "OK", f"{c.label}: OK"
    elif found == 0:
        st, msg = "MISSING", f"MISSING {exp} x {c.label}{pn}"
    elif found < exp:
        st, msg = "SHORT", f"Need {exp - found} more {c.label}{pn}  ({found}/{exp})"
    else:
        st, msg = "EXTRA", f"Remove {found - exp} x {c.label}{pn}  ({found}/{exp})"
    return ComponentResult(c.id, c.label, c.part_number, exp, found, st, round(score, 3), msg, c.roi)


def wrong_part(c: Component, seen: list[float] | None, score: float, want: str | None = None) -> ComponentResult:
    usual = c.material if c.material in colour.RULED and c.material != "colour" else colour.describe(c.colour_lab)
    accepted = " or ".join([usual] + list(c.alt_materials))          # e.g. "black or white"
    msg = f"WRONG PART? {c.label} should be {accepted}, this looks {colour.describe(seen)}"
    return ComponentResult(c.id, c.label, c.part_number, c.expected_count, 0, "WRONG_PART", round(score, 3), msg, c.roi)


# ---------------------------------------------------------------- inspector
class Inspector:
    def __init__(self, board: Board):
        self.board = board
        self.refs = board.refs()
        if not self.refs:
            raise ValueError(f"Board {board.board_id} has no reference image - teach it first")
        self.empty = board.empty()
        self.base = self.refs[0]
        # Align on the bare board when we have it: its features don't change when parts go missing.
        self.aligner = Aligner(self.empty if self.empty is not None else self.base) if board.align else None
        # Bare-board area (outside every part box): confirms the right board and measures the lighting.
        self.bg_mask = np.full(self.base.shape[:2], 255, np.uint8)
        for c in board.components:
            x, y, w, h = c.roi
            self.bg_mask[max(0, y):y + h, max(0, x):x + w] = 0
        # Bring extra references (and the empty board) into reference #1's position AND lighting,
        # so references taught at different times of day compare like for like.
        self.refs = [self.base] + [lighting.correct(self._to_base(r), self.base, self.bg_mask) for r in self.refs[1:]]
        if self.empty is not None:
            self.empty = lighting.correct(self._to_base(self.empty), self.base, self.bg_mask)
            if any(c.ref_fg_area <= 0 for c in board.components):
                self.calibrate()                   # board taught before colour learning: learn it now (in memory)

    def _board_similarity(self, live: np.ndarray, H, frame: np.ndarray) -> float:
        """NCC of the bare-board background vs reference: ~1 same board, ~0 different board."""
        mask = self.bg_mask
        if H is not None:
            hh, ww = self.base.shape[:2]
            valid = cv2.warpPerspective(np.full(frame.shape[:2], 255, np.uint8), H, (ww, hh))
            mask = cv2.bitwise_and(mask, cv2.erode(valid, np.ones((15, 15), np.uint8)))
        s = 240 / live.shape[1]
        a, b, m = (cv2.resize(z, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) for z in (
            cv2.cvtColor(live, cv2.COLOR_BGR2GRAY), cv2.cvtColor(self.base, cv2.COLOR_BGR2GRAY), mask))
        k = m > 200
        if k.sum() < 200:   # parts cover the whole board: nothing to compare, trust alignment
            return 1.0
        a = cv2.GaussianBlur(a, (5, 5), 0).astype(np.float32)[k]
        b = cv2.GaussianBlur(b, (5, 5), 0).astype(np.float32)[k]
        a -= a.mean(); b -= b.mean()
        return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-6))

    def _to_base(self, img: np.ndarray) -> np.ndarray:
        if img.shape[:2] != self.base.shape[:2]:
            img = cv2.resize(img, (self.base.shape[1], self.base.shape[0]))
        if self.aligner is not None:
            warped, score, _ = self.aligner.align(img)
            if warped is not None and score > 0.2:
                return warped
        return img

    # ---- calibration: learn each part's difference level, size and colour from the taught images
    def calibrate(self) -> list[str]:
        notes = []
        for c in self.board.components:
            if self.empty is None:
                if c.method == "count" or c.material != "auto":
                    notes.append(f"{c.label}: needs an empty-board image for counting / colour checks - capture one")
                continue
            e = _crop(self.empty, c.roi)
            levels = []
            for r in self.refs:
                d = np.abs(_lab(cv2.GaussianBlur(_crop(r, c.roi), (5, 5), 0)) - _lab(cv2.GaussianBlur(e, (5, 5), 0)))
                diff = np.maximum(d[..., 0] * 0.5, np.maximum(d[..., 1], d[..., 2]) * 1.5)
                part = diff[diff > 8]                 # pixels that clearly changed when the part went on
                # half way between "no change" and the part's typical change: keeps the whole part (a white
                # part on a light board differs only a little) while ignoring noise and light drift
                levels.append(float(np.clip(0.5 * np.median(part), 12, 40)) if part.size else 25.0)
            c.fg_level = float(np.median(levels))
            fg_areas, mat_areas, pixels = [], [], []
            for r in self.refs:
                p = _crop(r, c.roi)
                fg = _fg_mask(p, e, c.fg_level) > 0
                lab = _lab(cv2.GaussianBlur(p, (3, 3), 0))
                fg_areas.append(int(fg.sum()))
                if fg.any():
                    pixels.append(lab[fg])
            c.colour_lab = [round(float(v), 1) for v in np.median(np.concatenate(pixels), axis=0)] if pixels else None
            for r in self.refs:
                p = _crop(r, c.roi)
                mat = self._material_mask(c, p, e)
                mat_areas.append(int(mat.sum()))
            c.ref_fg_area = float(np.median(fg_areas))
            c.ref_mat_area = float(np.median(mat_areas))
            if c.method == "count":
                counted = [cv2.countNonZero(self._count_mask(c, _crop(r, c.roi), e)) for r in self.refs]
                c.unit_area = float(np.median(counted)) / max(1, c.expected_count)
            seen = colour.describe(c.colour_lab)
            notes.append(f"{c.label}: looks {seen}" + (f", material {c.material}" if c.material != "auto" else
                         f" (suggest material '{colour.suggest(c.colour_lab)}')"))
            if c.material in colour.RULED and c.ref_mat_area < 0.25 * max(1.0, c.ref_fg_area):
                notes.append(f"  ! {c.label}: taught part doesn't look {c.material} under this light - check the setting")
        return notes

    def _something(self, c: Component, patch: np.ndarray, empty_patch: np.ndarray):
        """(median colour of whatever is in the pocket, True if it covers a part-sized area)."""
        fg = _fg_mask(patch, empty_patch, min(c.fg_level, SOMETHING)) > 0
        if not fg.any():
            return None, False
        seen = [float(v) for v in np.median(_lab(cv2.GaussianBlur(patch, (3, 3), 0))[fg], axis=0)]
        return seen, fg.sum() >= 0.4 * c.ref_fg_area

    def _count_mask(self, c: Component, patch: np.ndarray, empty_patch: np.ndarray) -> np.ndarray:
        """Count shape from the difference mask; with a material rule, keep only blobs that are mostly
        that material (a hand, rag or wrong fastener in the pocket isn't counted)."""
        fg = _fg_mask(patch, empty_patch, c.fg_level)
        if c.material not in colour.RULED:
            return fg
        lab = _lab(cv2.GaussianBlur(patch, (3, 3), 0))
        allowed = self._allowed(c)
        rule = np.zeros(fg.shape, bool)
        for m in allowed:                                  # any allowed variant counts (black or zinc bolts...)
            r = colour.class_mask(lab, m, c.colour_lab if m == c.material else None)
            rule |= r if r is not None else (fg > 0)
        n, lab_ids, stats, _ = cv2.connectedComponentsWithStats(fg)
        keep = np.zeros(n, bool)
        for i in range(1, n):
            blob = lab_ids == i
            keep[i] = rule[blob].mean() >= 0.5
        return (keep[lab_ids] & (fg > 0)).astype(np.uint8) * 255

    def _material_mask(self, c: Component, patch: np.ndarray, empty_patch: np.ndarray) -> np.ndarray:
        """Pixels that differ from the empty board AND (for ruled materials) look like the part's material."""
        fg = _fg_mask(patch, empty_patch, c.fg_level) > 0
        rule = colour.class_mask(_lab(cv2.GaussianBlur(patch, (3, 3), 0)), c.material, c.colour_lab)
        return fg if rule is None else (fg & rule)

    # ---- per component checks
    def _allowed(self, c: Component) -> list[str]:
        """Accepted materials: the usual one plus its allowed variants (e.g. black, or white)."""
        return [c.material] + list(c.alt_materials)

    def _presence(self, c: Component, live: np.ndarray):
        """-> (found, score, info); info may hold 'variant' (an allowed non-usual colour was seen, e.g. white)
        or 'wrong' (median colour of a wrong part) + 'want' (the accepted colours)."""
        p = _crop(live, c.roi)
        d_full = min(_patch_dist(p, _crop(r, c.roi)) for r in self.refs)
        if self.empty is not None:
            d_empty = _patch_dist(p, _crop(self.empty, c.roi))
            score = d_empty / (d_full + d_empty + 1e-6)          # 1 = looks like full, 0 = looks empty
        else:
            score = float(np.clip(1.0 - d_full * 2, 0, 1))         # similarity to reference only
        found = c.expected_count if score >= c.threshold else 0
        if self.empty is None or c.ref_fg_area <= 0:
            return found, score, {}
        allowed = self._allowed(c)
        e = _crop(self.empty, c.roi)
        seen, something_there = self._something(c, p, e)
        wrong = None
        # 1) the usual material (learned colour profile)
        if c.material in colour.RULED and c.ref_mat_area > 0:
            mat_area = int(self._material_mask(c, p, e).sum())
            if mat_area < 0.4 * c.ref_mat_area:
                found = 0                                          # not enough of the usual colour
                if something_there and mat_area < 0.25 * c.ref_mat_area:
                    wrong = seen
        elif something_there and colour.distance(seen, c.colour_lab) > colour.PROFILE_TOL.get(c.material, 45):
            found, wrong = 0, seen
        if found:
            return found, score, {}
        # 2) an allowed variant (e.g. the white version of a usually-black bracket)
        fg = _fg_mask(p, e, min(c.fg_level, SOMETHING)) > 0
        lab = _lab(cv2.GaussianBlur(p, (3, 3), 0))
        for m in [m for m in allowed if m != c.material]:
            if (fg & colour.class_mask(lab, m)).sum() >= 0.5 * c.ref_fg_area:
                return c.expected_count, score, {"variant": m}
        if wrong is not None or (something_there and c.alt_materials):
            return 0, score, {"wrong": seen, "want": " or ".join(allowed)}
        return 0, score, {}

    def _count(self, c: Component, live: np.ndarray):
        if self.empty is None or c.unit_area <= 0:
            return self._presence(c, live)
        allowed = self._allowed(c)
        mask = self._count_mask(c, _crop(live, c.roi), _crop(self.empty, c.roi))
        area = cv2.countNonZero(mask)
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        blobs = int((stats[1:, cv2.CC_STAT_AREA] >= 0.35 * c.unit_area).sum()) if n > 1 else 0
        by_area = int(round(area / c.unit_area))
        found = max(by_area, blobs) if by_area > 0 else 0
        if found == 0 and c.material in colour.RULED and c.ref_fg_area > 0:
            seen, something_there = self._something(c, _crop(live, c.roi), _crop(self.empty, c.roi))
            if something_there:                                # parts are there, but the wrong colour
                return 0, 0.0, {"wrong": seen, "want": " or ".join(allowed)}
        return found, area / (c.unit_area * c.expected_count), {}

    def inspect(self, frame: np.ndarray, board_ok_override: bool | None = None):
        """Return (InspectionResult, aligned_frame)."""
        if frame.shape[:2] != self.base.shape[:2] and self.aligner is None:
            frame = cv2.resize(frame, (self.base.shape[1], self.base.shape[0]))
        if self.aligner is not None:
            live, score, H = self.aligner.align(frame)
        else:
            live, score, H = frame, 1.0, None
        if live is None:
            q = lighting.assess(frame)
            if not q.ok:                         # can't even find the board because it's too dark / blown out
                return self._unfit(q, frame), frame
            return InspectionResult(self.board.board_id, False, round(score, 3), False, [],
                                    "WRONG BOARD or board not in view"), frame
        mask = self.bg_mask
        if H is not None:
            hh, ww = self.base.shape[:2]
            valid = cv2.warpPerspective(np.full(frame.shape[:2], 255, np.uint8), H, (ww, hh))
            mask = cv2.bitwise_and(mask, cv2.erode(valid, np.ones((15, 15), np.uint8)))
        q = lighting.assess(live, self.base, mask)
        if not q.ok:
            return self._unfit(q, live), live
        raw = live
        live = lighting.correct(live, self.base, mask)
        score = min(score, self._board_similarity(live, H, frame))
        board_ok = score >= self.board.min_match_score
        if board_ok_override is False:
            board_ok = False
        if not board_ok:
            return InspectionResult(self.board.board_id, False, round(score, 3), False, [],
                                    "WRONG BOARD or board not in view", lighting=vars(q)), frame
        comps = []
        for c in self.board.components:
            blown = float((_crop(raw, c.roi).min(axis=2) >= lighting.CLIP).mean())
            if blown > 0.3 and c.material == "white" and c.method == "presence":
                comps.append(component_status(c, c.expected_count, 1.0))   # only a bright neutral part blows out
                continue                                                    # every colour: the white part is there
            if blown > 0.3:           # glare: the part can't be seen, so don't call it missing or present
                comps.append(ComponentResult(c.id, c.label, c.part_number, c.expected_count, 0, "GLARE", 0.0,
                                             f"Can't see {c.label} - glare, adjust the light", c.roi))
                continue
            found, s, info = (self._count if c.method == "count" else self._presence)(c, live)
            if "wrong" in info:
                comps.append(wrong_part(c, info["wrong"], s, info.get("want")))
            elif info.get("variant") and found == c.expected_count:
                comps.append(ComponentResult(c.id, c.label, c.part_number, c.expected_count, found, "OK", round(s, 3),
                                             f"{c.label}: OK ({info['variant']} variant)", c.roi, info["variant"]))
            else:
                comps.append(component_status(c, found, s))
        bad = [r for r in comps if r.status != "OK"]
        glare = [r for r in comps if r.status == "GLARE"]
        msg = "PASS - board complete" if not bad else f"FAIL - {len(bad)} item(s) to fix"
        if glare:
            msg = f"CHECK LIGHTING - glare on {len(glare)} item(s)"
            q.ok, q.message = False, msg
        return InspectionResult(self.board.board_id, True, round(score, 3), not bad, comps, msg,
                                lighting_ok=q.ok, lighting=vars(q)), live

    def _unfit(self, q: "lighting.Quality", img: np.ndarray) -> InspectionResult:
        return InspectionResult(self.board.board_id, False, 0.0, False, [], q.message,
                                lighting_ok=False, lighting=vars(q))


# ---------------------------------------------------------------- drawing
GREEN, RED, AMBER, WHITE = (70, 123, 30), (30, 38, 179), (68, 96, 135), (255, 255, 255)  # status pass/fail, Utemaster bronze


def annotate(img: np.ndarray, res: InspectionResult) -> np.ndarray:
    out = img.copy()
    for c in res.components:
        x, y, w, h = c.roi
        col = GREEN if c.status == "OK" else (AMBER if c.status in ("SHORT", "EXTRA") else RED)
        cv2.rectangle(out, (x, y), (x + w, y + h), col, 3)
        tag = f"{c.label} {c.found}/{c.expected}"
        (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(out, (x, max(0, y - th - 8)), (x + tw + 6, y), col, -1)
        cv2.putText(out, tag, (x + 3, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, WHITE, 2)
    banner = GREEN if res.passed else (AMBER if not res.lighting_ok else RED)
    cv2.rectangle(out, (0, 0), (out.shape[1], 44), banner, -1)
    cv2.putText(out, f"{res.board_id}: {res.message}", (12, 31), cv2.FONT_HERSHEY_SIMPLEX, 0.9, WHITE, 2)
    return out
