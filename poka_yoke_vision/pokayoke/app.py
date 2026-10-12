"""Local web UI (runs on the inspection PC, view in a browser on the station monitor).

    python -m pokayoke.app            -> http://localhost:8080  (operator)
                                         http://localhost:8080/teach  (engineer: build boards)
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory

from .board import Component
from .inspector import Inspector, annotate
from .station import FileCamera, Station

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = {
    "station_name": "PY-STATION-1",
    "camera_index": 0,
    "width": 1280,
    "height": 720,
    "fps": 2,
    "stable_frames": 3,
    "auto_stop_pass_seconds": 0,
    "qr_autoselect": False,
    "boards_dir": "boards",
    "results_dir": "results",
    "host": "127.0.0.1",
    "port": 8080,
}


def load_settings(path: Path) -> dict:
    s = dict(DEFAULTS)
    if path.exists():
        s.update(json.loads(path.read_text()))
    for k in ("boards_dir", "results_dir"):
        p = Path(s[k])
        s[k] = str(p if p.is_absolute() else path.parent / p)
    return s


def create_app(station: Station) -> Flask:
    app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
    st = station

    def err(msg, code=400):
        return jsonify({"error": msg}), code

    # ---------------- pages
    @app.get("/")
    def operator():
        return render_template("operator.html", station=st.s["station_name"])

    @app.get("/teach")
    def teach():
        return render_template("teach.html")

    # ---------------- video
    @app.get("/video.mjpg")
    def video():
        def gen():
            last = None
            while True:
                j = st.jpeg
                if j is not None and j is not last:
                    last = j
                    yield b"--f\r\nContent-Type: image/jpeg\r\n\r\n" + j + b"\r\n"
                time.sleep(0.1)
        return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=f")

    @app.get("/api/frame.jpg")
    def frame():
        if st.jpeg is None:
            abort(404)
        return Response(st.jpeg, mimetype="image/jpeg")

    # ---------------- operator
    @app.get("/api/status")
    def status():
        return jsonify(st.status())

    @app.post("/api/start")
    def start():
        b = request.get_json(force=True)
        try:
            st.start(b.get("board_id") or None, b.get("job_ref", ""), b.get("operator", ""))
        except Exception as e:
            return err(str(e))
        return jsonify(st.status())

    @app.post("/api/stop")
    def stop():
        rec = st.stop()
        return jsonify(rec or {"error": "not running"})

    @app.get("/results/<path:p>")
    def results(p):
        return send_from_directory(st.results_dir, p)

    # ---------------- boards (teach)
    @app.get("/api/boards")
    def boards():
        return jsonify(st.lib.summary())

    @app.post("/api/boards")
    def new_board():
        b = request.get_json(force=True)
        try:
            board = st.lib.create(b["board_id"], b.get("name", ""), b.get("product_line", ""))
        except (KeyError, ValueError) as e:
            return err(f"bad board: {e}")
        return jsonify({"board_id": board.board_id})

    @app.get("/api/boards/<bid>")
    def get_board(bid):
        try:
            b = st.lib.get(bid)
        except FileNotFoundError:
            abort(404)
        d = json.loads((b.folder / "board.json").read_text())
        return jsonify(d)

    @app.put("/api/boards/<bid>")
    def save_board(bid):
        b = st.lib.get(bid)
        d = request.get_json(force=True)
        try:
            b.name = d.get("name", b.name)
            b.product_line = d.get("product_line", b.product_line)
            b.align = bool(d.get("align", b.align))
            b.min_match_score = float(d.get("min_match_score", b.min_match_score))
            b.components = [Component(**c) for c in d.get("components", [])]
        except (TypeError, ValueError) as e:
            return err(str(e))
        notes = []
        if b.reference_images:
            notes = Inspector(b).calibrate()
        b.save()
        if st.board_id == b.board_id:
            st.select_board(b.board_id)
        return jsonify({"ok": True, "notes": notes})

    @app.post("/api/boards/<bid>/capture/<kind>")
    def capture(bid, kind):
        b = st.lib.get(bid)
        try:
            frame = st.snapshot()
        except Exception as e:
            return err(str(e))
        if kind == "empty":
            name = b.set_empty(frame)
        elif kind == "ref":
            name = b.add_reference(frame)
        else:
            abort(404)
        b.save()
        return jsonify({"saved": name})

    @app.delete("/api/boards/<bid>/refs")
    def clear_refs(bid):
        b = st.lib.get(bid)
        for n in b.reference_images:
            (b.folder / n).unlink(missing_ok=True)
        b.reference_images = []
        b.save()
        return jsonify({"ok": True})

    @app.get("/api/boards/<bid>/image/<name>")
    def board_image(bid, name):
        return send_from_directory(st.lib.get(bid).folder, name)

    @app.post("/api/boards/<bid>/test")
    def test_board(bid):
        """One-shot check of the current camera view against this board (no result file)."""
        try:
            insp = Inspector(st.lib.get(bid))
            res, view = insp.inspect(st.snapshot())
        except Exception as e:
            return err(str(e))
        ok, buf = cv2.imencode(".jpg", annotate(view, res))
        st.jpeg = buf.tobytes()
        return jsonify(res.to_dict())

    @app.post("/api/preview")
    def preview():
        on = bool(request.get_json(force=True).get("on"))
        try:
            st.preview(on)
        except Exception as e:
            return err(str(e))
        return jsonify({"mode": st.mode})

    return app


def main():
    ap = argparse.ArgumentParser(description="Poka-yoke board vision station")
    ap.add_argument("--settings", default=str(ROOT / "settings.json"))
    ap.add_argument("--image", help="use a still image instead of a camera (demo / testing)")
    a = ap.parse_args()
    s = load_settings(Path(a.settings))
    station = Station(s, FileCamera(a.image) if a.image else None)
    print(f"Operator screen: http://{s['host']}:{s['port']}/   Teach: http://{s['host']}:{s['port']}/teach")
    create_app(station).run(host=s["host"], port=s["port"], threaded=True)


if __name__ == "__main__":
    main()
