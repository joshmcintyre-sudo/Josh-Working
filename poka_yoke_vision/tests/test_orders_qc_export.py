import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from pokayoke import demo
from pokayoke.app import DEFAULTS, _merge, create_app
from pokayoke.orders import parse_order
from pokayoke.station import FileCamera, Station


@pytest.mark.parametrize("code,ref,typ", [("W234566", "W234566", "WORK_ORDER"), ("s98993", "S98993", "SALES_ORDER"),
                                          (" S98993\r", "S98993", "SALES_ORDER"), ("]C1W234566", "W234566", "WORK_ORDER")])
def test_parse_order(code, ref, typ):
    o = parse_order(code)
    assert (o["order_ref"], o["order_type"]) == (ref, typ)


@pytest.mark.parametrize("bad", ["", "X12345", "W12", "PY-HILUX-01"])
def test_parse_order_rejects(bad):
    with pytest.raises(ValueError):
        parse_order(bad)


class _Fake(BaseHTTPRequestHandler):
    """Stands in for Box (token + upload endpoints) and the downstream webhook app."""
    calls: list = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Fake.calls.append((self.path, self.headers.get("Authorization"), body))
        if self.path == "/oauth2/token":
            self._reply(200, {"access_token": "T0K", "expires_in": 3600})
        elif self.path == "/api/2.0/files/content":
            self._reply(201, {"entries": [{"id": str(len(_Fake.calls))}]})
        else:
            self._reply(200, {"ok": True})

    def _reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture()
def station(tmp_path):
    srv = HTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    _Fake.calls = []
    demo.build(tmp_path / "boards", tmp_path / "imgs")
    cam = FileCamera("x")
    s = _merge(DEFAULTS, {"boards_dir": str(tmp_path / "boards"), "results_dir": str(tmp_path / "res"), "fps": 10,
                          "stable_frames": 2, "auto_stop_pass_seconds": 0,
                          "export": {"retry_seconds": 3600,
                                     "webhook": {"enabled": True, "url": base + "/hook", "token": "abc"},
                                     "box": {"enabled": True, "folder_id": "777", "client_id": "id", "client_secret": "sec",
                                             "subject_id": "999", "api_base": base, "upload_base": base}}})
    st = Station(s, cam)
    yield st, cam, create_app(st).test_client()
    st.exporter.stop()
    srv.shutdown()


def _run(c, cam, img, order="W234566", op="JM"):
    cam.frame = img
    assert c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": order, "operator": op}).status_code == 200
    time.sleep(0.5)
    return c.post("/api/stop").get_json()


def test_fail_then_secondary_qc_confirm_logged_and_exported(station):
    st, cam, c = station
    o = c.get("/api/order?code=w234566").get_json()
    assert o["order_label"] == "Work order"
    assert c.get("/api/order?code=Q1").status_code == 400

    rec = _run(c, cam, demo.kitted(demo.bare_board(), loom=False))
    assert rec["result"] == "FAIL" and rec["order_type"] == "WORK_ORDER"

    assert c.post("/api/qc", json={"qc_by": "jm"}).status_code == 400           # same person as operator
    assert c.post("/api/qc", json={"qc_by": ""}).status_code == 400
    q = c.post("/api/qc", json={"qc_by": "AB", "note": "Loom bag under bracket, checked by hand"}).get_json()
    assert q["result"] == "QC_CONFIRMED" and q["vision_result"] == "FAIL"
    assert q["qc"]["statement"] == "Physically confirmed by secondary QC"
    assert c.get("/api/status").get_json()["prompt"].startswith("Physically confirmed by secondary QC (AB)")

    log = c.get("/api/log?q=W234566").get_json()
    assert len(log) == 1 and log[0]["final_result"] == "QC_CONFIRMED" and log[0]["qc_by"] == "AB"
    assert log[0]["image_url"].endswith(".jpg")
    assert "QC_CONFIRMED" in (st.results_dir / "inspections.csv").read_text()

    st.exporter.flush()
    paths = [p for p, *_ in _Fake.calls]
    assert paths.count("/hook") == 2                       # camera record + QC record
    uploads = [b for p, _, b in _Fake.calls if p == "/api/2.0/files/content"]
    assert len(uploads) == 3                               # record json + image + QC json
    assert b'"parent": {"id": "777"}' in uploads[0] and b"W234566_DEMO-HILUX-01_" in uploads[0]
    assert all(a == "Bearer T0K" for p, a, _ in _Fake.calls if p == "/api/2.0/files/content")
    assert all(a == "Bearer abc" for p, a, _ in _Fake.calls if p == "/hook")
    assert not list((st.results_dir / "outbox" / "pending").glob("*.json"))
    assert c.get("/api/log?q=W234566").get_json()[0]["export_status"].startswith("sent")


def test_pass_needs_no_qc_and_export_retries_when_offline(station):
    st, cam, c = station
    st.exporter.webhook["url"] = "http://127.0.0.1:9/down"     # nothing listening
    rec = _run(c, cam, demo.kitted(demo.bare_board()), order="S98993")
    assert rec["result"] == "PASS" and rec["order_type"] == "SALES_ORDER"
    assert c.post("/api/qc", json={"qc_by": "AB"}).status_code == 400
    st.exporter.flush()
    assert len(list((st.results_dir / "outbox" / "pending").glob("*.json"))) == 1   # kept for retry
    assert "retrying" in c.get("/api/log").get_json()[0]["export_status"]
