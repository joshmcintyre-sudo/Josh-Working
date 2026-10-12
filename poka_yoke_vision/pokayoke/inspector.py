"""Vision engine: align live frame to the taught reference, then check every labelled region.

Classic OpenCV only (ORB + homography, LAB colour difference, foreground area) so it runs
on an office PC CPU at 1-5 fps with no GPU and no model training.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import cv2
import numpy as np

from .board import Board, Component

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


def _match_lighting(img: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Global gain/offset on L channel so shop lighting drift doesn't read as a missing part."""
    li, lr = _lab(img), _lab(ref)
    m_i, s_i = li[..., 0].mean(), li[..., 0].std() + 1e-6
    m_r, s_r = lr[..., 0].mean(), lr[..., 0].std() + 1e-6
    li[..., 0] = np.clip((li[..., 0] - m_i) * (s_r / s_i) + m_r, 0, 255)
    return cv2.cvtColor(li.astype(np.uint8), cv2.COLOR_LAB2BGR)


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
        self.kp, self.des = self.orb.detectAndCompute(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), None)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

    def align(self, frame: np.ndarray):
        """Return (warped_frame_in_ref_coords | None, match_score 0..1, homography | None)."""
        if self.des is None or len(self.kp) < 20:
            return None, 0.0, None
        kp, des = self.orb.detectAndCompute(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), None)
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
    status: str        # OK | MISSING | SHORT | EXTRA
    score: float
    message: str
    roi: list[int]


@dataclass
class InspectionResult:
    board_id: str
    board_ok: bool
    match_score: float
    passed: bool
    components: list[ComponentResult]
    message: str

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
        # Bring extra references into the coordinate frame of reference #1.
        self.refs = [self.base] + [self._to_base(r) for r in self.refs[1:]]
        if self.empty is not None:
            self.empty = self._to_base(self.empty)
        # Bare-board area (outside every part box) is used to confirm it's the right board.
        self.bg_mask = np.full(self.base.shape[:2], 255, np.uint8)
        for c in board.components:
            x, y, w, h = c.roi
            self.bg_mask[max(0, y):y + h, max(0, x):x + w] = 0

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

    # ---- calibration: learn per-part size and difference level from the taught images
    def calibrate(self) -> list[str]:
        notes = []
        for c in self.board.components:
            if c.method != "count":
                continue
            if self.empty is None:
                notes.append(f"{c.label}: 'count' needs an empty-board image - capture one")
                continue
            e = _crop(self.empty, c.roi)
            levels, areas = [], []
            for r in self.refs:
                p = _crop(r, c.roi)
                d = np.abs(_lab(p) - _lab(e))
                diff = np.maximum(d[..., 0] * 0.5, np.maximum(d[..., 1], d[..., 2]) * 1.5)
                otsu, _ = cv2.threshold(np.clip(diff, 0, 255).astype(np.uint8), 0, 255,
                                        cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                levels.append(float(np.clip(otsu, 12, 60)))
            c.fg_level = float(np.median(levels))
            for r in self.refs:
                areas.append(cv2.countNonZero(_fg_mask(_crop(r, c.roi), e, c.fg_level)))
            c.unit_area = float(np.median(areas)) / max(1, c.expected_count)
            notes.append(f"{c.label}: unit area {c.unit_area:.0f}px, level {c.fg_level:.0f}")
        return notes

    # ---- per component checks
    def _presence(self, c: Component, live: np.ndarray):
        p = _crop(live, c.roi)
        d_full = min(_patch_dist(p, _crop(r, c.roi)) for r in self.refs)
        if self.empty is not None:
            d_empty = _patch_dist(p, _crop(self.empty, c.roi))
            score = d_empty / (d_full + d_empty + 1e-6)          # 1 = looks like full, 0 = looks empty
        else:
            score = float(np.clip(1.0 - d_full * 2, 0, 1))         # similarity to reference only
        found = c.expected_count if score >= c.threshold else 0
        return found, score

    def _count(self, c: Component, live: np.ndarray):
        if self.empty is None or c.unit_area <= 0:
            return self._presence(c, live)
        mask = _fg_mask(_crop(live, c.roi), _crop(self.empty, c.roi), c.fg_level)
        area = cv2.countNonZero(mask)
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        blobs = int((stats[1:, cv2.CC_STAT_AREA] >= 0.35 * c.unit_area).sum()) if n > 1 else 0
        by_area = int(round(area / c.unit_area))
        found = max(by_area, blobs) if by_area > 0 else 0
        return found, area / (c.unit_area * c.expected_count)

    def inspect(self, frame: np.ndarray, board_ok_override: bool | None = None):
        """Return (InspectionResult, aligned_frame)."""
        if frame.shape[:2] != self.base.shape[:2] and self.aligner is None:
            frame = cv2.resize(frame, (self.base.shape[1], self.base.shape[0]))
        if self.aligner is not None:
            live, score, H = self.aligner.align(frame)
        else:
            live, score, H = frame, 1.0, None
        if live is not None:
            score = min(score, self._board_similarity(live, H, frame))
        board_ok = live is not None and score >= self.board.min_match_score
        if board_ok_override is False:
            board_ok = False
        if not board_ok:
            return InspectionResult(self.board.board_id, False, round(score, 3), False, [],
                                    "WRONG BOARD or board not in view"), frame
        live = _match_lighting(live, self.base)
        comps = []
        for c in self.board.components:
            found, s = (self._count if c.method == "count" else self._presence)(c, live)
            comps.append(component_status(c, found, s))
        bad = [r for r in comps if r.status != "OK"]
        msg = "PASS - board complete" if not bad else f"FAIL - {len(bad)} item(s) to fix"
        return InspectionResult(self.board.board_id, True, round(score, 3), not bad, comps, msg), live


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
    banner = GREEN if res.passed else RED
    cv2.rectangle(out, (0, 0), (out.shape[1], 44), banner, -1)
    cv2.putText(out, f"{res.board_id}: {res.message}", (12, 31), cv2.FONT_HERSHEY_SIMPLEX, 0.9, WHITE, 2)
    return out
