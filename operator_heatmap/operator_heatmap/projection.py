"""360 (equirectangular) -> flat perspective view, so 360 feeds look like a fixed camera."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class View360:
    yaw: float = 0.0      # degrees, 0 = centre of the equirect image, +right
    pitch: float = -20.0  # degrees, negative = look down at the floor
    fov: float = 100.0    # horizontal field of view in degrees
    width: int = 1600
    height: int = 1000


class EquirectDewarper:
    """Builds the remap tables once, then dewarps each frame cheaply."""

    def __init__(self, src_w: int, src_h: int, view: View360):
        self.view = view
        w, h = view.width, view.height
        f = 0.5 * w / np.tan(np.radians(view.fov) / 2)
        xs, ys = np.meshgrid(np.arange(w) - w / 2, np.arange(h) - h / 2)
        # Camera rays (x right, y down, z forward)
        dirs = np.stack([xs, ys, np.full_like(xs, f)], axis=-1)
        dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)

        p, y = -np.radians(view.pitch), np.radians(view.yaw)  # camera y is down, so negate pitch
        rx = np.array([[1, 0, 0], [0, np.cos(p), np.sin(p)], [0, -np.sin(p), np.cos(p)]])
        ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
        d = dirs @ (ry @ rx).T

        lon = np.arctan2(d[..., 0], d[..., 2])           # -pi..pi
        lat = np.arcsin(np.clip(d[..., 1], -1, 1))       # -pi/2..pi/2 (down = +)
        self.map_x = ((lon / (2 * np.pi) + 0.5) * src_w).astype(np.float32)
        self.map_y = ((lat / np.pi + 0.5) * src_h).astype(np.float32)

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        return cv2.remap(frame, self.map_x, self.map_y, cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_WRAP)
