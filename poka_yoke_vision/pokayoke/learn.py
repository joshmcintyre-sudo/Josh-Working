"""Guided learn mode for operators: empty board -> load parts one at a time (system finds each
new part and asks for its name) -> repeat captures of the full board -> save & calibrate.

Everything is held in memory until commit(), so cancelling never breaks an existing board.
"""
from __future__ import annotations

import cv2
import numpy as np

from .board import Board, Component
from .inspector import Aligner, _match_lighting

STEPS = ("empty", "part", "name", "repeat", "done")


def find_added_part(prev: np.ndarray, curr: np.ndarray, min_frac: float = 0.0004, pad: int = 12):
    """Box around what changed between two aligned captures (the part just placed), or None."""
    curr = _match_lighting(curr, prev)
    a = cv2.GaussianBlur(prev, (7, 7), 0).astype(np.int16)
    b = cv2.GaussianBlur(curr, (7, 7), 0).astype(np.int16)
    diff = np.abs(a - b).max(axis=2).astype(np.uint8)
    level, _ = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = (diff > max(30, level)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    mask = cv2.dilate(mask, np.ones((15, 15), np.uint8))   # join bolts in one pocket into one box
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    min_area = min_frac * mask.size
    blobs = [stats[i] for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    if not blobs:
        return None
    big = max(s[cv2.CC_STAT_AREA] for s in blobs)
    blobs = [s for s in blobs if s[cv2.CC_STAT_AREA] >= 0.05 * big]   # drop specks far from the part
    x0 = min(s[0] for s in blobs); y0 = min(s[1] for s in blobs)
    x1 = max(s[0] + s[2] for s in blobs); y1 = max(s[1] + s[3] for s in blobs)
    H, W = mask.shape
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(W, x1 + pad), min(H, y1 + pad)
    return [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


class LearnSession:
    def __init__(self, board: Board, repeats: int = 3):
        self.board = board
        self.repeats = max(1, int(repeats))
        self.step = "empty"
        self.empty: np.ndarray | None = None
        self.prev: np.ndarray | None = None       # last accepted capture (aligned to empty)
        self.pending: np.ndarray | None = None
        self.proposal: list[int] | None = None
        self.components: list[Component] = []
        self.refs: list[np.ndarray] = []
        self.message = "Place the EMPTY board under the camera, hands clear, then press CAPTURE"
        self._aligner: Aligner | None = None

    # ---- helpers
    def _align(self, frame: np.ndarray) -> np.ndarray:
        if self._aligner is None:
            return frame
        warped, score, _ = self._aligner.align(frame)
        return warped if warped is not None and score > 0.2 else frame

    def state(self) -> dict:
        return {"step": self.step, "message": self.message, "proposal": self.proposal,
                "parts": [{"label": c.label, "part_number": c.part_number, "qty": c.expected_count,
                           "method": c.method, "roi": c.roi} for c in self.components],
                "ref_count": len(self.refs), "repeats": self.repeats, "board_id": self.board.board_id}

    def image(self) -> np.ndarray | None:
        img = self.pending if self.pending is not None else self.prev
        if img is None:
            return None
        out = img.copy()
        for c in self.components:
            x, y, w, h = c.roi
            cv2.rectangle(out, (x, y), (x + w, y + h), (60, 180, 60), 3)
            cv2.putText(out, f"{c.label} x{c.expected_count}", (x + 4, max(18, y - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (60, 180, 60), 2)
        if self.proposal:
            x, y, w, h = self.proposal
            cv2.rectangle(out, (x, y), (x + w, y + h), (0, 170, 255), 4)
            cv2.putText(out, "NEW PART", (x + 4, max(18, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 170, 255), 2)
        return out

    # ---- operator actions
    def capture(self, frame: np.ndarray) -> dict:
        if self.step == "empty":
            self.empty = frame
            self._aligner = Aligner(frame)
            if len(self._aligner.kp) < 50:
                self.message = "Not enough detail seen - check camera focus/lighting and capture again"
                self.empty = self._aligner = None
                return self.state()
            self.prev = frame
            self.step = "part"
            self.message = "Load PART 1 onto the board, hands clear, then press CAPTURE"
        elif self.step == "part":
            f = self._align(frame)
            roi = find_added_part(self.prev, f)
            if roi is None:
                self.message = (f"No new part found - place part {len(self.components) + 1} in view "
                                "(hands clear) and CAPTURE again")
            else:
                self.pending, self.proposal = f, roi
                self.step = "name"
                self.message = "Name this part (orange box), enter part number and quantity, then SAVE PART"
        elif self.step == "undo":
            self.prev = self._align(frame)
            self.step = "part"
            self.message = f"Load PART {len(self.components) + 1} and CAPTURE - or press ALL PARTS LOADED"
        elif self.step == "repeat":
            self.refs.append(self._align(frame))
            self._repeat_message()
        return self.state()

    def name_part(self, label: str, part_number: str = "", qty: int = 1) -> dict:
        if self.step != "name" or not label.strip():
            self.message = "Enter a part name"
            return self.state()
        qty = max(1, int(qty))
        self.components.append(Component(
            id=f"c{len(self.components) + 1}", label=label.strip(), part_number=part_number.strip(),
            roi=self.proposal, expected_count=qty, method="count" if qty > 1 else "presence"))
        self.prev, self.pending, self.proposal = self.pending, None, None
        self.step = "part"
        self.message = f"Saved. Load PART {len(self.components) + 1} and CAPTURE - or press ALL PARTS LOADED"
        return self.state()

    def retry(self) -> dict:
        self.pending = self.proposal = None
        self.step = "part"
        self.message = f"Adjust PART {len(self.components) + 1} (hands clear) and CAPTURE again"
        return self.state()

    def undo(self) -> dict:
        """Remove the last saved part (operator must take it off the board)."""
        if self.step == "part" and self.components:
            c = self.components.pop()
            self.message = f"Removed '{c.label}'. Take it OFF the board, then CAPTURE"
            self.step = "undo"
        return self.state()

    def parts_done(self) -> dict:
        if self.step != "part" or not self.components:
            self.message = "Teach at least one part first"
            return self.state()
        self.refs = [self.prev]
        self.step = "repeat"
        self._repeat_message()
        return self.state()

    def _repeat_message(self):
        if len(self.refs) >= self.repeats:
            self.step = "done"
            self.message = "Learning complete - press SAVE BOARD"
        else:
            self.message = (f"Reference {len(self.refs) + 1} of {self.repeats}: lift and re-place the parts "
                            "(as an operator normally would), hands clear, then CAPTURE")

    def commit(self) -> Board:
        """Write images + board.json, calibrate counts. Replaces any previous teaching."""
        from .inspector import Inspector
        b = self.board
        b.folder.mkdir(parents=True, exist_ok=True)
        for n in b.reference_images:
            (b.folder / n).unlink(missing_ok=True)
        b.reference_images, b.components = [], list(self.components)
        b.set_empty(self.empty)
        for r in self.refs:
            b.add_reference(r)
        Inspector(b).calibrate()
        b.save()
        self.step = "saved"
        return b
