"""Camera + operator session: START opens the camera and inspects at low fps, STOP closes it and
writes the result file (JSON + annotated JPG + one CSV row)."""
from __future__ import annotations

import csv
import json
import platform
import threading
import time
from collections import Counter, deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .board import BoardLibrary
from .inspector import InspectionResult, Inspector, annotate, component_status


class Camera:
    """Background grabber so we always process the newest frame (no USB buffer lag)."""

    def __init__(self, index: int = 0, width: int = 1280, height: int = 720):
        self.index, self.width, self.height = index, width, height
        self.cap = None
        self.frame = None
        self._run = False
        self._lock = threading.Lock()

    def open(self) -> None:
        backend = cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_ANY
        self.cap = cv2.VideoCapture(self.index, backend)
        if not self.cap.isOpened():
            raise RuntimeError(f"Camera {self.index} not found - check USB / camera_index in settings.json")
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self._run = True
        threading.Thread(target=self._loop, daemon=True).start()
        t0 = time.time()                       # let auto-exposure settle
        while self.frame is None and time.time() - t0 < 5:
            time.sleep(0.05)
        time.sleep(0.5)

    def _loop(self):
        while self._run:
            ok, f = self.cap.read()
            if ok:
                with self._lock:
                    self.frame = f
            else:
                time.sleep(0.02)

    def read(self) -> np.ndarray | None:
        with self._lock:
            return None if self.frame is None else self.frame.copy()

    def close(self) -> None:
        self._run = False
        time.sleep(0.1)
        if self.cap is not None:
            self.cap.release()
        self.cap, self.frame = None, None


class FileCamera(Camera):
    """Stand-in camera that serves a still image (testing / demo without hardware)."""

    def __init__(self, path: str):
        super().__init__()
        self.path = path

    def open(self):
        self.frame = cv2.imread(self.path)
        if self.frame is None:
            raise RuntimeError(f"Cannot read {self.path}")

    def close(self):
        pass


class Station:
    def __init__(self, settings: dict, camera: Camera | None = None):
        self.s = settings
        self.lib = BoardLibrary(Path(settings["boards_dir"]))
        self.results_dir = Path(settings["results_dir"])
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self.camera = camera or Camera(settings["camera_index"], settings["width"], settings["height"])
        self.mode = "idle"                    # idle | preview | inspect
        self.board_id: str | None = None
        self.inspector: Inspector | None = None
        self.job = {}
        self.history: deque[InspectionResult] = deque(maxlen=max(1, settings["stable_frames"]))
        self.latest: InspectionResult | None = None
        self.jpeg: bytes | None = None
        self.last_file: str | None = None
        self.error: str | None = None
        self._pass_since: float | None = None
        self._qr = cv2.QRCodeDetector()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------ board selection
    def select_board(self, board_id: str) -> None:
        board = self.lib.get(board_id)
        self.inspector = Inspector(board)
        self.board_id = board.board_id

    # ------------------------------------------------ camera lifecycle
    def _ensure_camera(self):
        if self.camera.read() is None:
            self.camera.open()

    def preview(self, on: bool) -> None:
        if self.mode == "inspect":
            return
        if on:
            self._ensure_camera()
            self.mode = "preview"
            self._start_loop()
        else:
            self.mode = "idle"
            self.camera.close()

    def snapshot(self) -> np.ndarray:
        opened_here = self.camera.read() is None
        self._ensure_camera()
        frame = self.camera.read()
        if opened_here and self.mode == "idle":
            self.camera.close()
        if frame is None:
            raise RuntimeError("No frame from camera")
        return frame

    # ------------------------------------------------ inspection session
    def start(self, board_id: str | None, job_ref: str = "", operator: str = "") -> None:
        if self.mode == "inspect":
            return
        if board_id:
            self.select_board(board_id)
        if self.inspector is None and not self.s.get("qr_autoselect"):
            raise RuntimeError("Select a board first")
        self.job = {"job_ref": job_ref, "operator": operator, "started": datetime.now().isoformat(timespec="seconds")}
        self.history.clear()
        self.latest, self.last_file, self.error, self._pass_since = None, None, None, None
        self._ensure_camera()
        self.mode = "inspect"
        self._start_loop()

    def stop(self) -> dict | None:
        if self.mode != "inspect":
            return None
        self.mode = "idle"
        if self._thread:
            self._thread.join(timeout=3)
        self.camera.close()
        return self._write_result()

    def _start_loop(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        period = 1.0 / max(0.2, float(self.s["fps"]))
        while self.mode in ("preview", "inspect"):
            t0 = time.time()
            frame = self.camera.read()
            if frame is not None:
                try:
                    self._process(frame)
                except Exception as e:  # keep the line running; show the error on screen
                    self.error = str(e)
            if self.mode == "inspect" and self._auto_stop_due():
                threading.Thread(target=self.stop, daemon=True).start()
                return
            time.sleep(max(0.0, period - (time.time() - t0)))

    def _process(self, frame: np.ndarray):
        if self.mode == "preview" or (self.inspector is None and not self.s.get("qr_autoselect")):
            self._publish(frame)
            return
        qr_ok = None
        if self.s.get("qr_autoselect"):
            text, *_ = self._qr.detectAndDecode(frame)
            text = (text or "").strip()
            if text and text in self.lib.ids():
                if text != self.board_id:
                    if self.inspector is None:
                        self.select_board(text)
                    else:
                        qr_ok = False   # label says a different board than the one selected
        if self.inspector is None:
            self._publish(frame, "Show board QR label to camera")
            return
        res, view = self.inspector.inspect(frame, board_ok_override=qr_ok)
        if qr_ok is False:
            res.message = "WRONG BOARD - QR label does not match selected board"
        with self._lock:
            self.history.append(res)
            self.latest = self._stable()
        self._publish(annotate(view, self.latest))

    def _publish(self, img: np.ndarray, text: str | None = None):
        if text:
            img = img.copy()
            cv2.putText(img, text, (12, 36), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 170, 255), 2)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            self.jpeg = buf.tobytes()
            self._last_img = img

    def _stable(self) -> InspectionResult:
        """Vote over the last N frames so a hand passing over the board doesn't flip the result."""
        last = self.history[-1]
        if not last.board_ok or len(self.history) == 1:
            return last
        frames = [r for r in self.history if r.board_ok and len(r.components) == len(last.components)]
        comps = []
        for i, c in enumerate(self.inspector.board.components):
            found = Counter(r.components[i].found for r in frames).most_common(1)[0][0]
            score = float(np.mean([r.components[i].score for r in frames]))
            comps.append(component_status(c, found, score))
        bad = [c for c in comps if c.status != "OK"]
        msg = "PASS - board complete" if not bad else f"FAIL - {len(bad)} item(s) to fix"
        return InspectionResult(last.board_id, True, last.match_score, not bad, comps, msg)

    def _auto_stop_due(self) -> bool:
        secs = float(self.s.get("auto_stop_pass_seconds", 0))
        if secs <= 0 or self.latest is None:
            return False
        if self.latest.passed and len(self.history) == self.history.maxlen:
            self._pass_since = self._pass_since or time.time()
            return time.time() - self._pass_since >= secs
        self._pass_since = None
        return False

    # ------------------------------------------------ output
    def _write_result(self) -> dict:
        now = datetime.now()
        res = self.latest
        record = {
            "station": self.s.get("station_name", platform.node()),
            "board_id": self.board_id,
            "job_ref": self.job.get("job_ref", ""),
            "operator": self.job.get("operator", ""),
            "started": self.job.get("started"),
            "finished": now.isoformat(timespec="seconds"),
            "result": "NO_RESULT" if res is None else ("PASS" if res.passed else "FAIL"),
            "inspection": None if res is None else res.to_dict(),
        }
        day = self.results_dir / now.strftime("%Y-%m-%d")
        day.mkdir(parents=True, exist_ok=True)
        stem = f"{self.board_id or 'unknown'}_{now:%H%M%S}" + (f"_{record['job_ref']}" if record["job_ref"] else "")
        stem = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in stem)
        json_path = day / f"{stem}.json"
        if getattr(self, "_last_img", None) is not None:
            cv2.imwrite(str(day / f"{stem}.jpg"), self._last_img)
            record["image"] = f"{stem}.jpg"
        json_path.write_text(json.dumps(record, indent=2))

        csv_path = self.results_dir / "inspections.csv"
        new = not csv_path.exists()
        with csv_path.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["finished", "station", "board_id", "job_ref", "operator", "result",
                            "match_score", "problems", "file"])
            probs = "" if res is None else "; ".join(c.message for c in res.problems)
            w.writerow([record["finished"], record["station"], record["board_id"], record["job_ref"],
                        record["operator"], record["result"], None if res is None else res.match_score,
                        probs, str(json_path)])
        self.last_file = str(json_path)
        return record

    def status(self) -> dict:
        with self._lock:
            return {
                "mode": self.mode,
                "board_id": self.board_id,
                "job": self.job,
                "result": None if self.latest is None else self.latest.to_dict(),
                "last_file": self.last_file,
                "error": self.error,
            }
