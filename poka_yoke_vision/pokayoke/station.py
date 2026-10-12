"""Camera + operator session: START opens the camera and inspects at low fps, STOP closes it and
writes the result file (JSON + annotated JPG + one CSV row)."""
from __future__ import annotations

import csv
import json
import platform
import threading
import time
import uuid
from collections import Counter, deque
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .board import BoardLibrary
from .export import Exporter
from .inspector import InspectionResult, Inspector, annotate, component_status
from .orderlog import OrderLog
from .orders import parse_order
from . import scanner


def _clean_launch(launch: dict | None) -> dict | None:
    """Ops Hub launch context carried on every record (launch_id ties the result to the checklist step)."""
    if not launch or not launch.get("launch_id"):
        return None
    keep = ("launch_id", "source", "step", "checklist", "model")
    return {k: str(launch.get(k, ""))[:120] for k in keep}


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
        self.last_record: dict | None = None
        self.error: str | None = None
        self._pass_since: float | None = None
        self.scan_result = {"seq": 0, "at": 0.0, "codes": []}
        self._lookup_cache: dict[str, str | None] = {}
        self._lookup_t = 0.0
        self.learn = None                     # LearnSession while in guided learn mode
        self.log = OrderLog(self.results_dir / "order_log.db")
        self.exporter = Exporter(settings, self.results_dir,
                                 lambda rid, st: self.log.set_export_status(rid.removesuffix("_QC"), st)) \
            if settings.get("export") else None
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

    def scan(self, on: bool) -> None:
        """Camera as barcode scanner (order / model / QC badge). Stays open into verify or learn."""
        if self.mode in ("inspect", "preview"):
            return
        if on:
            self._ensure_camera()
            self.mode = "scan"
            self._start_loop()
        elif self.mode == "scan":
            self.mode = "idle"
            if self._thread:
                self._thread.join(timeout=3)
            self.camera.close()

    def preview(self, on: bool) -> None:
        if self.mode == "inspect":
            return
        if on:                                 # from idle or scan (camera already open)
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
    def start(self, board_id: str | None, order_ref: str = "", operator: str = "", launch: dict | None = None) -> None:
        if self.mode == "inspect":
            return
        if board_id:
            self.select_board(board_id)
        if self.inspector is None and not self.s.get("qr_autoselect"):
            raise RuntimeError("Select a board first")
        order = parse_order(order_ref, self.s.get("order_types"), self.s.get("order_pattern")) if order_ref else \
            {"order_ref": "", "order_type": ""}
        self.job = {"order_ref": order["order_ref"], "order_type": order["order_type"], "operator": operator,
                    "started": datetime.now().astimezone().isoformat(timespec="seconds"), "session_id": uuid.uuid4().hex,
                    "launch": _clean_launch(launch)}
        self._send_started()
        self.history.clear()
        self.latest, self.last_file, self.error, self._pass_since = None, None, None, None
        self.last_record = None
        self._last_img = None
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

    def cancel(self) -> None:
        """Back to idle without writing a result (operator abort / leaving learn mode)."""
        self.mode = "idle"
        if self._thread:
            self._thread.join(timeout=3)
        self.camera.close()
        self.learn = None

    def _start_loop(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while self.mode in ("preview", "inspect", "scan"):
            t0 = time.time()
            period = 1.0 / max(0.2, float(self.s["scan_fps"] if self.mode == "scan" else self.s["fps"]))
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

    def _lookup(self, code: str) -> str | None:
        """Barcode -> board_id, cached so per-frame label checks don't re-read every board file."""
        if time.time() - self._lookup_t > 10:
            self._lookup_cache, self._lookup_t = {}, time.time()
        if code not in self._lookup_cache:
            self._lookup_cache[code] = self.lib.lookup(code)
        return self._lookup_cache[code]

    def _process(self, frame: np.ndarray):
        if self.mode == "scan":
            codes = scanner.decode(frame)
            if codes:
                with self._lock:
                    self.scan_result = {"seq": self.scan_result["seq"] + 1, "at": time.time(), "codes": [
                        {"text": c["text"], "format": c["format"]} for c in codes]}
            self._publish(scanner.draw(frame, codes, "SCANNER - hold barcode under camera"), keep=False)
            return
        if self.mode == "preview" or (self.inspector is None and not self.s.get("qr_autoselect")):
            self._publish(frame)
            return
        label_ok = None
        if self.s.get("qr_autoselect"):     # board label check: any barcode/QR on the board that maps to a board
            for c in scanner.decode(frame):
                bid = self._lookup(c["text"])
                if bid and bid != self.board_id:
                    if self.inspector is None:
                        self.select_board(bid)
                    else:
                        label_ok = False   # label says a different board than the one selected
                    break
        if self.inspector is None:
            self._publish(frame, "Show board label to camera")
            return
        res, view = self.inspector.inspect(frame, board_ok_override=label_ok)
        if label_ok is False:
            res.message = "WRONG BOARD - label does not match selected board"
        with self._lock:
            self.history.append(res)
            self.latest = self._stable()
        self._publish(annotate(view, self.latest))

    def _publish(self, img: np.ndarray, text: str | None = None, keep: bool = True):
        if text:
            img = img.copy()
            cv2.putText(img, text, (12, 36), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 170, 255), 2)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            self.jpeg = buf.tobytes()
            if keep:
                self._last_img = img

    def _stable(self) -> InspectionResult:
        """Vote over the last N frames so a hand passing over the board doesn't flip the result."""
        last = self.history[-1]
        if not last.board_ok or not last.lighting_ok or len(self.history) == 1:
            return last                     # wrong board / bad light is shown as-is, never voted into a PASS
        frames = [r for r in self.history if r.board_ok and len(r.components) == len(last.components)]
        comps = []
        for i, c in enumerate(self.inspector.board.components):
            # vote on (count, status) so a WRONG_PART / GLARE verdict survives the vote with its message
            key = Counter((r.components[i].found, r.components[i].status) for r in frames).most_common(1)[0][0]
            pick = next(r.components[i] for r in reversed(frames) if (r.components[i].found, r.components[i].status) == key)
            score = float(np.mean([r.components[i].score for r in frames]))
            comps.append(component_status(c, pick.found, score) if pick.status in ("OK", "MISSING", "SHORT", "EXTRA")
                         else replace(pick, score=round(score, 3)))
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
        now = datetime.now().astimezone()        # timezone-aware: Ops Hub stores timestamptz
        res = self.latest
        # an image not fit to judge (too dark, glare, covered lens) is recorded as NO_RESULT, not FAIL
        vision = "NO_RESULT" if res is None or not res.lighting_ok else ("PASS" if res.passed else "FAIL")
        stem = "_".join(x for x in (self.job.get("order_ref"), self.board_id or "unknown", f"{now:%Y%m%d-%H%M%S}") if x)
        stem = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in stem)
        record = {
            "record_id": stem,
            "event": "completed",
            "launch_id": (self.job.get("launch") or {}).get("launch_id"),
            "launch": self.job.get("launch"),
            "session_id": self.job.get("session_id"),
            "station": self.s.get("station_name", platform.node()),
            "order_ref": self.job.get("order_ref", ""),
            "order_type": self.job.get("order_type", ""),
            "board_id": self.board_id,
            "operator": self.job.get("operator", ""),
            "started": self.job.get("started"),
            "finished": now.isoformat(timespec="seconds"),
            "vision_result": vision,
            "result": vision,                      # final result; becomes QC_CONFIRMED after secondary QC
            "qc": None,
            "operator_prompt": self.s["pass_message"] if vision == "PASS" else self.s["fail_message"],
            "inspection": None if res is None else res.to_dict(),
        }
        day = self.results_dir / now.strftime("%Y-%m-%d")
        day.mkdir(parents=True, exist_ok=True)
        if getattr(self, "_last_img", None) is not None:
            cv2.imwrite(str(day / f"{stem}.jpg"), self._last_img)
            record["image"] = f"{stem}.jpg"
        self.last_file = str(day / f"{stem}.json")
        self.last_record = record
        self._save(record)
        return record

    def qc_confirm(self, qc_by: str, note: str = "") -> dict:
        """Secondary QC physically checked a board the camera could not confirm."""
        rec = self.last_record
        if rec is None:
            raise RuntimeError("No inspection to confirm")
        if rec["result"] == "PASS":
            raise RuntimeError("Board already passed - no QC override needed")
        qc_by = qc_by.strip()
        if not qc_by:
            raise RuntimeError("QC initials required")
        if self.s.get("qc_must_differ", True) and qc_by.lower() == (rec.get("operator") or "").strip().lower():
            raise RuntimeError("Secondary QC must be a different person to the operator")
        rec["qc"] = {"by": qc_by, "note": note.strip(), "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                     "statement": "Physically confirmed by secondary QC"}
        rec["result"] = "QC_CONFIRMED"
        rec["event"] = "qc_confirmed"
        rec["operator_prompt"] = f"Physically confirmed by secondary QC ({qc_by}) - {self.s['pass_message']}"
        self._save(rec, suffix="_QC")
        return rec

    def _send_started(self) -> None:
        """'Order logged / check started' stamp to the webhook (Ops Hub) as soon as verify begins."""
        wh = self.s.get("export", {}).get("webhook", {})
        if self.exporter is None or not wh.get("enabled") or not wh.get("send_started", True):
            return
        ev = {"event": "started", "record_id": f"{self.job['session_id']}_started",
              "session_id": self.job["session_id"], "station": self.s.get("station_name", platform.node()),
              "order_ref": self.job["order_ref"], "order_type": self.job["order_type"], "board_id": self.board_id,
              "operator": self.job["operator"], "started": self.job["started"],
              "launch_id": (self.job.get("launch") or {}).get("launch_id"), "launch": self.job.get("launch")}
        d = self.results_dir / "outbox" / "events"
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{ev['record_id']}.json"
        p.write_text(json.dumps(ev, indent=2))
        self.exporter.enqueue(ev, p, None, only=["webhook"])

    def _save(self, record: dict, suffix: str = "") -> None:
        """JSON file + CSV audit row + order log + export queue."""
        json_path = Path(self.last_file)
        json_path.write_text(json.dumps(record, indent=2))
        image_path = json_path.with_name(record["image"]) if record.get("image") else None
        res = record["inspection"]
        probs = "" if not res else "; ".join(c["message"] for c in res["components"] if c["status"] != "OK") or \
            ("" if res["board_ok"] else res["message"])
        qc = record["qc"] or {}

        csv_path = self.results_dir / "inspections.csv"
        new = not csv_path.exists()
        with csv_path.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["finished", "station", "order_ref", "order_type", "board_id", "operator",
                            "vision_result", "result", "qc_by", "qc_note", "problems", "file"])
            w.writerow([qc.get("at") or record["finished"], record["station"], record["order_ref"],
                        record["order_type"], record["board_id"], record["operator"], record["vision_result"],
                        record["result"], qc.get("by", ""), qc.get("note", ""), probs, str(json_path)])

        # log row first, so a fast background send can't be overwritten by a stale "queued" status
        export = "queued" if self.exporter is not None and self.exporter.targets() else "not configured"
        self.log.upsert({**record, "qc_by": qc.get("by"), "qc_note": qc.get("note"), "qc_at": qc.get("at"),
                         "final_result": record["result"], "problems": probs, "json_path": str(json_path),
                         "image_path": str(image_path) if image_path else "", "export_status": export})
        if export == "queued":
            # QC update goes out as its own file so the original camera record is never overwritten downstream
            out = json_path
            if suffix:
                out = json_path.with_name(json_path.stem + suffix + ".json")
                out.write_text(json.dumps(record, indent=2))
            self.exporter.enqueue({**record, "record_id": record["record_id"] + suffix}, out,
                                  None if suffix else image_path)

    def status(self) -> dict:
        with self._lock:
            return {
                "mode": self.mode,
                "board_id": self.board_id,
                "job": self.job,
                "result": None if self.latest is None else self.latest.to_dict(),
                "last_file": self.last_file,
                "last_result": self.last_record and self.last_record["result"],
                "prompt": self.last_record and self.last_record["operator_prompt"],
                "qc": self.last_record and self.last_record["qc"],
                "error": self.error,
            }
