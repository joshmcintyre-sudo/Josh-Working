"""Handles pokayoke://launch?... links from Ops Hub (registered by install_windows.bat).

Starts the station server if it isn't running, then opens the launch page in the browser:
    pokayoke://launch?launch_id=..&order=W234566&model=..&return=..
 -> http://127.0.0.1:8080/launch?launch_id=..&order=W234566&model=..&return=..
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _port() -> int:
    try:
        return int(json.loads((ROOT / "settings.json").read_text()).get("port", 8080))
    except (OSError, ValueError):
        return 8080


def running(base: str) -> bool:
    try:
        with urllib.request.urlopen(base + "/api/ping", timeout=1.5) as r:
            return r.status == 200
    except OSError:
        return False


def to_http(link: str, base: str) -> str:
    q = urllib.parse.urlsplit(link).query
    return f"{base}/launch?{q}" if q else base + "/"


def main(argv: list[str]) -> int:
    base = f"http://127.0.0.1:{_port()}"
    link = argv[1] if len(argv) > 1 else ""
    if not running(base):
        exe = Path(sys.executable)
        pyw = exe.with_name("pythonw.exe")
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen([str(pyw if pyw.exists() else exe), "-m", "pokayoke.app"], cwd=ROOT, creationflags=flags,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            if running(base):
                break
            time.sleep(0.5)
    webbrowser.open(to_http(link, base))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
