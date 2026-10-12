"""Poka-yoke board definitions: one folder per board under boards/<board_id>/.

boards/<board_id>/
    board.json        - metadata + labelled component regions
    empty.png         - (recommended) photo of the bare board, no parts
    ref_1.png ...     - photo(s) of a correctly kitted board
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

METHODS = ("presence", "count")


@dataclass
class Component:
    id: str
    label: str                       # shown to operator, e.g. "M8 x 25 flange bolt"
    roi: list[int]                   # [x, y, w, h] in reference-image pixels
    expected_count: int = 1
    method: str = "presence"         # "presence" (single item) | "count" (multiple loose items)
    part_number: str = ""
    threshold: float = 0.5           # presence: 0..1 decision point (0.5 = halfway between empty and full)
    unit_area: float = 0.0           # count: learned px area of one part (set by calibrate)
    fg_level: float = 25.0           # count: colour-difference level that counts as "part" (set by calibrate)

    def __post_init__(self):
        if self.method not in METHODS:
            raise ValueError(f"{self.id}: method must be one of {METHODS}")
        if len(self.roi) != 4 or self.roi[2] <= 0 or self.roi[3] <= 0:
            raise ValueError(f"{self.id}: roi must be [x, y, w, h] with w,h > 0")
        self.roi = [int(v) for v in self.roi]


@dataclass
class Board:
    board_id: str
    name: str = ""
    product_line: str = ""
    components: list[Component] = field(default_factory=list)
    reference_images: list[str] = field(default_factory=list)
    empty_image: str = ""
    align: bool = True               # warp live frame onto reference (board can shift on bench)
    min_match_score: float = 0.5     # below this the board is flagged as wrong / not found
    folder: Path | None = None

    # ---------- persistence ----------
    @classmethod
    def load(cls, folder: Path) -> "Board":
        data = json.loads((folder / "board.json").read_text())
        comps = [Component(**c) for c in data.pop("components", [])]
        return cls(components=comps, folder=folder, **data)

    def save(self) -> None:
        assert self.folder is not None
        self.folder.mkdir(parents=True, exist_ok=True)
        d = asdict(self)
        d.pop("folder")
        (self.folder / "board.json").write_text(json.dumps(d, indent=2))

    # ---------- images ----------
    def _read(self, name: str) -> np.ndarray | None:
        if not name or self.folder is None:
            return None
        img = cv2.imread(str(self.folder / name))
        return img

    def refs(self) -> list[np.ndarray]:
        return [im for im in (self._read(n) for n in self.reference_images) if im is not None]

    def empty(self) -> np.ndarray | None:
        return self._read(self.empty_image)

    def add_reference(self, frame: np.ndarray) -> str:
        name = f"ref_{len(self.reference_images) + 1}.png"
        cv2.imwrite(str(self.folder / name), frame)
        self.reference_images.append(name)
        return name

    def set_empty(self, frame: np.ndarray) -> str:
        self.empty_image = "empty.png"
        cv2.imwrite(str(self.folder / self.empty_image), frame)
        return self.empty_image


class BoardLibrary:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def ids(self) -> list[str]:
        return sorted(p.name for p in self.root.iterdir() if (p / "board.json").exists())

    def summary(self) -> list[dict]:
        out = []
        for bid in self.ids():
            b = self.get(bid)
            out.append({"board_id": b.board_id, "name": b.name, "product_line": b.product_line,
                        "components": len(b.components), "refs": len(b.reference_images),
                        "has_empty": bool(b.empty_image)})
        return out

    def get(self, board_id: str) -> Board:
        return Board.load(self.root / safe_id(board_id))

    def create(self, board_id: str, name: str = "", product_line: str = "") -> Board:
        bid = safe_id(board_id)
        b = Board(board_id=bid, name=name or bid, product_line=product_line, folder=self.root / bid)
        b.save()
        return b


def safe_id(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_.-]+", "-", s.strip()).strip("-.")
    if not s:
        raise ValueError("board_id is empty")
    return s
