import time

import cv2
import numpy as np
import pytest

zxingcpp = pytest.importorskip("zxingcpp")

from pokayoke import demo, scanner
from pokayoke.app import DEFAULTS, _merge, create_app
from pokayoke.station import FileCamera, Station


def label(text, fmt="Code128", scale=3):
    img = np.array(zxingcpp.create_barcode(text, getattr(zxingcpp.BarcodeFormat, fmt)).to_image(scale=scale))
    img = np.pad(img, 30, constant_values=255)                    # white label stock
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def stick(frame, lab, x, y):
    """Paper label lying on the bench / board, seen by the overhead camera."""
    out = frame.copy()
    h, w = lab.shape[:2]
    out[y:y + h, x:x + w] = lab
    return out


@pytest.mark.parametrize("fmt", ["Code128", "Code39", "QRCode", "DataMatrix"])
def test_decode_formats_on_board(fmt):
    frame = stick(demo.bare_board(), label("W234566", fmt), 520, 300)
    assert [c["text"] for c in scanner.decode(frame)] == ["W234566"]


def test_decode_small_label_upscales():
    lab = label("S98993", scale=1)                                # ~1 px per module: far from camera
    assert [c["text"] for c in scanner.decode(stick(demo.bare_board(), lab, 600, 400))] == ["S98993"]


def test_decode_nothing_on_plain_board():
    assert scanner.decode(demo.kitted(demo.bare_board())) == []


@pytest.fixture()
def rig(tmp_path):
    demo.build(tmp_path / "boards", tmp_path / "imgs")
    cam = FileCamera("x")
    cam.frame = demo.bare_board()
    s = _merge(DEFAULTS, {"boards_dir": str(tmp_path / "boards"), "results_dir": str(tmp_path / "res"),
                          "fps": 10, "scan_fps": 20, "stable_frames": 2, "auto_stop_pass_seconds": 0})
    st = Station(s, cam)
    yield st, cam, create_app(st).test_client()
    st.cancel()


def wait_seq(c, seq, text, n=40):
    for _ in range(n):
        r = c.get("/api/scan").get_json()
        if r["seq"] > seq and any(x["text"] == text for x in r["codes"]):
            return r
        time.sleep(0.05)
    raise AssertionError("no scan")


def test_camera_scan_order_then_model_then_verify(rig):
    st, cam, c = rig
    # model barcode registered against the demo board
    b = st.lib.get("DEMO-HILUX-01"); b.barcodes.append("9312345678907"); b.save()

    assert c.post("/api/scan", json={"on": True}).get_json() == {"mode": "scan", "engine": "zxing-cpp"}
    seq = c.get("/api/scan").get_json()["seq"]
    cam.frame = stick(demo.bare_board(), label("W234566"), 500, 300)           # despatch paperwork under camera
    r = wait_seq(c, seq, "W234566")
    code = r["codes"][0]
    assert code["text"] == "W234566" and code["format"] == "Code128"
    assert code["order"]["order_type"] == "WORK_ORDER" and code["board_id"] is None

    cam.frame = stick(demo.kitted(demo.bare_board()), label("9312345678907", "EAN13"), 650, 480)   # model label
    r = wait_seq(c, r["seq"], "9312345678907")
    assert r["codes"][0]["board_id"] == "DEMO-HILUX-01" and r["codes"][0]["order"] is None

    # verify starts straight from scan mode (camera stays open) and works as normal
    cam.frame = demo.kitted(demo.bare_board())
    c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": code["text"], "operator": "JM"})
    assert st.mode == "inspect"
    time.sleep(0.5)
    assert c.post("/api/stop").get_json()["result"] == "PASS"

    c.post("/api/scan", json={"on": True})
    c.post("/api/scan", json={"on": False})
    assert st.mode == "idle"


def test_board_label_mismatch_flags_wrong_board(rig):
    st, cam, c = rig
    st.s["qr_autoselect"] = True
    other = st.lib.create("PY-RANGER-02", "Ranger")
    other.barcodes.append("RANGER-KIT"); other.save()
    cam.frame = stick(demo.kitted(demo.bare_board()), label("RANGER-KIT", "QRCode", 4), 1080, 520)
    c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": "S98993", "operator": "JM"})
    time.sleep(0.6)
    rec = c.post("/api/stop").get_json()
    assert rec["result"] == "FAIL"
    assert rec["inspection"]["message"].startswith("WRONG BOARD - label")
