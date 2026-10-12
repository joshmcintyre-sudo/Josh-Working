"""Local web UI (runs on the inspection PC, view in a browser on the station monitor).

    python -m pokayoke.app            -> http://localhost:8080  (operator)
                                         http://localhost:8080/teach  (engineer: build boards)
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import urllib.parse
import time
from pathlib import Path

import cv2
from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory

from .board import Component
from .inspector import Inspector, annotate
from .learn import LearnSession
from .orders import parse_order
from . import scanner
from .station import FileCamera, Station

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = {
    "station_name": "PY-STATION-1",
    "camera_index": 0,
    "width": 1280,
    "height": 720,
    "fps": 2,
    "stable_frames": 3,
    "auto_stop_pass_seconds": 2,
    "learn_repeats": 3,
    "pass_message": "Now ready to bag and package kit",
    "fail_message": "Review despatch list and verify all items are present",
    "qr_autoselect": False,
    "boards_dir": "boards",
    "results_dir": "results",
    "host": "127.0.0.1",
    "port": 8080,
    "order_types": {"W": "Work order", "S": "Sales order"},
    "order_pattern": "^[A-Z]\\d{4,10}$",
    "qc_must_differ": True,
    "camera_scan": True,          # show "scan with camera" on order / model / QC screens
    "camera_scan_auto": True,     # start camera scanning automatically on those screens
    "scan_fps": 5,
    # Ops Hub (or other web apps) allowed to launch this station and receive the "Return" link
    "ops_hub_origins": ["https://*.lovable.app"],
    "export": {
        "retry_seconds": 60,
        "webhook": {"enabled": False, "url": "", "token": ""},
        "box": {"enabled": False, "folder_id": "", "client_id": "", "client_secret": "",
                "subject_type": "enterprise", "subject_id": "", "developer_token": ""},
    },
}


def _merge(base: dict, extra: dict) -> dict:
    out = dict(base)
    for k, v in extra.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_settings(path: Path) -> dict:
    s = dict(DEFAULTS)
    if path.exists():
        s = _merge(s, json.loads(path.read_text()))
    secrets = path.with_name("secrets.json")       # Box / webhook credentials, kept out of git
    if secrets.exists():
        s = _merge(s, json.loads(secrets.read_text()))
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
        return render_template("operator.html", station=st.s["station_name"], launch=None)

    def allowed_origin(url: str) -> str | None:
        """'https://x.lovable.app/mes?...' -> 'https://x.lovable.app' if it matches ops_hub_origins."""
        p = urllib.parse.urlparse(url or "")
        origin = f"{p.scheme}://{p.netloc}" if p.scheme in ("http", "https") and p.netloc else ""
        if origin and any(fnmatch.fnmatch(origin, pat) for pat in st.s.get("ops_hub_origins", [])):
            return origin
        return None

    @app.get("/launch")
    def launch():
        """Opened by an Ops Hub MES checklist step:
        /launch?launch_id=<uuid>&order=W234566&model=<assembly item>&operator=JM&step=...&return=<ops hub url>"""
        a = request.args
        try:
            order = parse_order(a.get("order", ""), st.s["order_types"], st.s["order_pattern"])
        except ValueError as e:
            return render_template("operator.html", station=st.s["station_name"], launch={"error": str(e)})
        ret = a.get("return", "")
        launch = {
            "launch_id": re.sub(r"[^A-Za-z0-9-]", "", a.get("launch_id", ""))[:64],
            "order": order["order_ref"], "model": a.get("model", "").strip()[:80],
            "operator": a.get("operator", "").strip()[:40], "step": a.get("step", "").strip()[:120],
            "checklist": a.get("checklist", "").strip()[:120],
            "return_url": ret if allowed_origin(ret) else "",
            "source": "ops_hub",
        }
        return render_template("operator.html", station=st.s["station_name"], launch=launch)

    @app.route("/api/ping", methods=["GET", "OPTIONS"])
    def ping():
        """Lets Ops Hub check the station app is running before launching it (CORS + Private Network Access)."""
        origin = allowed_origin(request.headers.get("Origin", ""))
        resp = jsonify({"ok": True, "station": st.s["station_name"], "mode": st.mode}) \
            if request.method == "GET" else Response(status=204)
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Methods"] = "GET"
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
            resp.headers["Vary"] = "Origin"
        return resp

    @app.get("/teach")
    def teach():
        return render_template("teach.html", station=st.s["station_name"])

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
            st.start(b.get("board_id") or None, b.get("order_ref", ""), b.get("operator", ""), b.get("launch"))
        except Exception as e:
            return err(str(e))
        return jsonify(st.status())

    @app.post("/api/stop")
    def stop():
        rec = st.stop()
        return jsonify(rec or {"error": "not running"})

    @app.get("/api/order")
    def order():
        try:
            o = parse_order(request.args.get("code", ""), st.s["order_types"], st.s["order_pattern"])
        except ValueError as e:
            return err(str(e))
        o["history"] = st.log.query(q=o["order_ref"], limit=10)
        return jsonify(o)

    @app.post("/api/qc")
    def qc():
        b = request.get_json(force=True)
        try:
            rec = st.qc_confirm(b.get("qc_by", ""), b.get("note", ""))
        except RuntimeError as e:
            return err(str(e))
        return jsonify(rec)

    @app.get("/log")
    def log_page():
        return render_template("log.html", station=st.s["station_name"])

    @app.get("/api/log")
    def log_api():
        rows = st.log.query(request.args.get("q", ""), request.args.get("result", ""),
                            int(request.args.get("limit", 200)))
        for r in rows:
            p = Path(r["image_path"] or "")
            r["image_url"] = f"/results/{p.parent.name}/{p.name}" if r["image_path"] else ""
        return jsonify(rows)

    @app.post("/api/export/flush")
    def export_flush():
        if st.exporter is None:
            return err("Export not configured")
        st.exporter.flush()
        return jsonify({"ok": True})

    @app.post("/api/scan")
    def scan_onoff():
        on = bool(request.get_json(force=True).get("on"))
        try:
            st.scan(on)
        except Exception as e:
            return err(str(e))
        return jsonify({"mode": st.mode, "engine": scanner.available()})

    @app.get("/api/scan")
    def scan_read():
        """Latest camera barcode read. Each code is tagged as an order and/or a known model board."""
        r = dict(st.scan_result)
        codes = []
        for c in r["codes"]:
            try:
                order = parse_order(c["text"], st.s["order_types"], st.s["order_pattern"])
            except ValueError:
                order = None
            codes.append({**c, "order": order, "board_id": st.lib.lookup(c["text"])})
        return jsonify({"seq": r["seq"], "age": round(time.time() - r["at"], 2) if r["at"] else None,
                        "codes": codes, "mode": st.mode, "engine": scanner.available()})

    @app.get("/api/config")
    def config():
        return jsonify({k: st.s[k] for k in ("camera_scan", "camera_scan_auto", "station_name")})

    @app.post("/api/cancel")
    def cancel():
        st.cancel()
        return jsonify(st.status())

    @app.get("/api/lookup")
    def lookup():
        """Scanned model barcode -> board. taught = has parts + reference so it can be verified."""
        code = request.args.get("code", "")
        bid = st.lib.lookup(code)
        if not bid:
            return jsonify({"code": code, "board_id": None, "taught": False})
        b = st.lib.get(bid)
        return jsonify({"code": code, "board_id": bid, "name": b.name, "product_line": b.product_line,
                        "taught": bool(b.components and b.reference_images), "parts": len(b.components)})

    # ---------------- guided learn mode (operator)
    def learn_state():
        if st.learn is None:
            return err("Not in learn mode")
        return jsonify(st.learn.state())

    @app.post("/api/learn/start")
    def learn_start():
        b = request.get_json(force=True)
        code = (b.get("code") or b.get("board_id") or "").strip()
        try:
            bid = st.lib.lookup(code) or st.lib.create(code, b.get("name", ""), b.get("product_line", "")).board_id
        except ValueError as e:
            return err(str(e))
        board = st.lib.get(bid)
        if code and code.lower() != bid.lower() and code not in board.barcodes:
            board.barcodes.append(code)          # remember the scanned model barcode for next time
        st.cancel()
        st.learn = LearnSession(board, b.get("repeats") or st.s["learn_repeats"])
        st.preview(True)
        return learn_state()

    @app.get("/api/learn/state")
    def learn_get():
        return learn_state()

    @app.post("/api/learn/<action>")
    def learn_action(action):
        L = st.learn
        if L is None:
            return err("Not in learn mode")
        b = request.get_json(silent=True) or {}
        try:
            if action == "capture":
                L.capture(st.snapshot())
            elif action == "part":
                L.name_part(b.get("label", ""), b.get("part_number", ""), int(b.get("qty") or 1))
            elif action == "retry":
                L.retry()
            elif action == "undo":
                L.undo()
            elif action == "parts_done":
                L.parts_done()
            elif action == "save":
                if L.step != "done":
                    return err("Learning not finished")
                board = L.commit()
                st.cancel()
                st.select_board(board.board_id)
                return jsonify({"step": "saved", "board_id": board.board_id,
                                "message": "Board saved - load a finished board and VERIFY"})
            else:
                abort(404)
        except Exception as e:
            return err(str(e))
        return learn_state()

    @app.get("/api/learn/image.jpg")
    def learn_image():
        img = st.learn.image() if st.learn else None
        if img is None:
            abort(404)
        return Response(cv2.imencode(".jpg", img)[1].tobytes(), mimetype="image/jpeg")

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
