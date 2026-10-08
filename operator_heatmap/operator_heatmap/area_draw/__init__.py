"""On-screen area drawing for the Streamlit app (include / exclude / doorway polygons and rectangles)."""
import base64
import os

import cv2
import numpy as np
import streamlit.components.v1 as components

_component = components.declare_component(
    "area_draw", path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend"))


def area_draw(frame_bgr: np.ndarray, shapes: list[dict], key: str, max_width: int = 900,
              crop: tuple[int, int, int, int] | None = None) -> list[dict] | None:
    """Show the frame and let the user draw areas on it.

    shapes: [{"use": "include"|"exclude"|"entry", "poly": [[x, y], ...]}] in full-frame pixels.
    crop: (x1, y1, x2, y2) part of the frame to show (e.g. without black borders); coordinates stay full-frame.
    Returns the updated list after the user draws, or None before the first change.
    """
    x0, y0 = 0, 0
    if crop is not None:
        x0, y0, x1, y1 = crop
        frame_bgr = frame_bgr[y0:y1, x0:x1]
        shapes = [{"use": sh["use"], "poly": [[x - x0, y - y0] for x, y in sh["poly"]]} for sh in shapes]
    h, w = frame_bgr.shape[:2]
    s = min(1.0, max_width / w)
    small = cv2.resize(frame_bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else frame_bgr
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 80])
    url = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
    out = _component(image=url, scale=w / small.shape[1], shapes=shapes, key=key, default=None)
    if out is None or not (x0 or y0):
        return out
    return [{"use": sh["use"], "poly": [[x + x0, y + y0] for x, y in sh["poly"]]} for sh in out]


def shapes_to_spec(shapes: list[dict]) -> dict:
    spec = {"include": [], "exclude": [], "entry": []}
    for sh in shapes or []:
        if sh.get("use") in spec and len(sh.get("poly", [])) >= 3:
            spec[sh["use"]].append({"poly": sh["poly"]})
    return spec


def spec_to_shapes(spec: dict) -> list[dict]:
    """Load a saved area file (only pixel polygons can be drawn back on screen)."""
    out = []
    for use in ("include", "exclude", "entry"):
        for shape in spec.get(use, []):
            if "poly" in shape:
                out.append({"use": use, "poly": shape["poly"]})
    return out
