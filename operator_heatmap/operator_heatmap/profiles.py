"""Camera profiles: areas + camera settings saved per camera name, reused by the app and the nightly job.

Stored as  operator_heatmap\\cameras\\<camera name>.json  next to the app.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re

DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cameras")


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _.-]+", "_", name).strip() or "camera"


def camera_name_from_file(path: str) -> str:
    """'Internal 360 3_2026_10_08_14_30_00.mp4' -> 'Internal 360 3' (Nx exports start with the camera name)."""
    stem = os.path.splitext(os.path.basename(path))[0]
    m = re.match(r"^(.*?)[ _-]*(?:19|20)\d\d[-_.]?\d\d", stem)
    return (m.group(1) if m and m.group(1).strip() else stem).strip(" _-")


def path_for(name: str) -> str:
    return os.path.join(DIR, safe(name) + ".json")


def load(name: str) -> dict:
    try:
        with open(path_for(name)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_if_changed(name: str, profile: dict) -> bool:
    """Write the profile when it differs from what is on disk. Returns True if written."""
    old = load(name)
    keep = {k: v for k, v in old.items() if k != "saved"}
    if keep == json.loads(json.dumps(profile)):
        return False
    os.makedirs(DIR, exist_ok=True)
    with open(path_for(name), "w") as fh:
        json.dump({**profile, "saved": dt.datetime.now().isoformat(timespec="seconds")}, fh, indent=1)
    return True
