import json
import time

import cv2
import numpy as np
import pytest

from pokayoke import demo
from pokayoke.app import DEFAULTS, create_app
from pokayoke.board import BoardLibrary
from pokayoke.inspector import Inspector
from pokayoke.station import FileCamera, Station


@pytest.fixture()
def lib(tmp_path):
    demo.build(tmp_path / "boards", tmp_path / "imgs")
    return BoardLibrary(tmp_path / "boards")


@pytest.fixture()
def insp(lib):
    return Inspector(lib.get("DEMO-HILUX-01"))


def status(res):
    return {c.label: (c.status, c.found) for c in res.components}


def moved(img, dx=25, dy=-15, angle=3.0, scale=0.97):
    """Board pushed slightly off-position on the bench."""
    M = cv2.getRotationMatrix2D((img.shape[1] / 2, img.shape[0] / 2), angle, scale)
    M[:, 2] += (dx, dy)
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), borderValue=(60, 60, 60))


def test_good_board_passes(insp):
    res, _ = insp.inspect(demo.kitted(demo.bare_board()))
    assert res.board_ok and res.passed, status(res)


def test_missing_and_short(insp):
    res, _ = insp.inspect(demo.kitted(demo.bare_board(), seal=False, bolts=4))
    s = status(res)
    assert not res.passed
    assert s["Door seal 450mm"] == ("MISSING", 0)
    assert s["M8 x 25 flange bolt"] == ("SHORT", 4)
    assert s["Mounting bracket LH"][0] == "OK"
    msg = next(c.message for c in res.components if c.status == "SHORT")
    assert msg.startswith("Need 2 more M8 x 25 flange bolt")


@pytest.mark.parametrize("kw", [{"bracket": False}, {"loom": False}, {"bolts": 0}, {"bolts": 1}])
def test_each_part_detected_missing(insp, kw):
    res, _ = insp.inspect(demo.kitted(demo.bare_board(), **kw))
    assert not res.passed and len(res.problems) == 1, status(res)


def test_board_moved_and_lighting_change(insp):
    img = moved(demo.kitted(demo.bare_board()))
    img = cv2.convertScaleAbs(img, alpha=0.8, beta=25)  # dimmer/washed-out shop light
    res, _ = insp.inspect(img)
    assert res.passed, status(res)
    res, _ = insp.inspect(moved(demo.kitted(demo.bare_board(), loom=False)))
    assert status(res)["Wiring loom bag"][0] == "MISSING"


def test_wrong_board_rejected(insp):
    res, _ = insp.inspect(demo.kitted(demo.bare_board(seed=99)))
    assert not res.board_ok and not res.passed


def test_station_start_stop_writes_result(lib, tmp_path):
    img = tmp_path / "live.png"
    cv2.imwrite(str(img), demo.kitted(demo.bare_board(), bolts=5))
    s = dict(DEFAULTS, boards_dir=str(lib.root), results_dir=str(tmp_path / "results"), fps=10)
    st = Station(s, FileCamera(str(img)))
    client = create_app(st).test_client()
    assert client.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": "W1001", "operator": "JM"}).status_code == 200
    for _ in range(50):
        if st.latest is not None and len(st.history) >= 3:
            break
        time.sleep(0.05)
    rec = client.post("/api/stop").get_json()
    assert rec["result"] == "FAIL" and rec["order_ref"] == "W1001" and rec["order_type"] == "WORK_ORDER"
    saved = json.loads(open(st.last_file).read())
    bolts = next(c for c in saved["inspection"]["components"] if c["part_number"] == "FAST-M8-25")
    assert (bolts["found"], bolts["status"]) == (5, "SHORT")
    csv_text = (tmp_path / "results" / "inspections.csv").read_text()
    assert "Need 1 more M8 x 25 flange bolt" in csv_text


def test_teach_api_roundtrip(lib, tmp_path):
    img = tmp_path / "live.png"
    cv2.imwrite(str(img), demo.kitted(demo.bare_board()))
    s = dict(DEFAULTS, boards_dir=str(lib.root), results_dir=str(tmp_path / "r"))
    c = create_app(Station(s, FileCamera(str(img)))).test_client()
    assert c.post("/api/boards", json={"board_id": "PY RANGER 02", "name": "Ranger"}).get_json()["board_id"] == "PY-RANGER-02"
    assert c.post("/api/boards/PY-RANGER-02/capture/ref").status_code == 200
    r = c.put("/api/boards/PY-RANGER-02", json={"components": [
        {"id": "a", "label": "Bracket", "roi": [110, 110, 230, 130]}]})
    assert r.get_json()["ok"]
    t = c.post("/api/boards/PY-RANGER-02/test").get_json()
    assert t["passed"]
    assert c.put("/api/boards/PY-RANGER-02", json={"components": [{"id": "a", "label": "x", "roi": [0, 0, 0, 5]}]}).status_code == 400


def _iou(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx)); iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    return ix * iy / (aw * ah + bw * bh - ix * iy)


def test_operator_learn_then_verify_workflow(tmp_path):
    """Idle -> scan model -> guided learn (part by part) -> verify -> PASS prompt / FAIL prompt."""
    bare = demo.bare_board()
    cam = FileCamera(str(tmp_path / "x.png"))
    cam.frame = bare
    s = dict(DEFAULTS, boards_dir=str(tmp_path / "boards"), results_dir=str(tmp_path / "res"), fps=10,
             auto_stop_pass_seconds=0.3, stable_frames=2, learn_repeats=2)
    st = Station(s, cam)
    c = create_app(st).test_client()

    assert c.get("/api/lookup?code=SKU-99812").get_json()["board_id"] is None
    r = c.post("/api/learn/start", json={"code": "SKU-99812", "name": "Ranger kit"}).get_json()
    assert r["step"] == "empty"
    assert c.post("/api/learn/capture").get_json()["step"] == "part"

    expected = {c_.label: c_.roi for c_ in demo.components()}
    steps = [("Mounting bracket LH", dict(bracket=True, seal=False, loom=False, bolts=0, ties=False), 1),
             ("Door seal 450mm", dict(bracket=True, seal=True, loom=False, bolts=0, ties=False), 1),
             ("Wiring loom bag", dict(bracket=True, seal=True, loom=True, bolts=0, ties=False), 1),
             ("M8 x 25 flange bolt", dict(bracket=True, seal=True, loom=True, bolts=6, ties=False), 6),
             ("Cable tie bundle", dict(bracket=True, seal=True, loom=True, bolts=6, ties=True), 1)]
    for label, kw, qty in steps:
        cam.frame = demo.kitted(bare, **kw)
        r = c.post("/api/learn/capture").get_json()
        assert r["step"] == "name", r
        assert _iou(r["proposal"], expected[label]) > 0.5, (label, r["proposal"])
        want = {"Mounting bracket LH": "black", "Door seal 450mm": "black", "Wiring loom bag": "colour",
                "M8 x 25 flange bolt": "black", "Cable tie bundle": "white"}[label]
        assert r["suggested_material"] == want, (label, r["suggested_material"])
        mat = "bag" if label == "Wiring loom bag" else want          # operator overrides: it's a bag
        r = c.post("/api/learn/part", json={"label": label, "qty": qty, "material": mat}).get_json()
        assert r["parts"][-1]["material"] == mat
        assert r["step"] == "part"
    # capturing with nothing new placed must not invent a part: it asks the operator to draw one (or retry)
    r = c.post("/api/learn/capture").get_json()
    assert r["step"] == "name" and r["proposal"] is None
    assert c.post("/api/learn/retry").get_json()["step"] == "part"
    assert c.post("/api/learn/parts_done").get_json()["step"] == "repeat"
    cam.frame = moved(demo.kitted(bare), 10, 5, 1.0, 1.0)
    assert c.post("/api/learn/capture").get_json()["step"] == "done"
    assert c.post("/api/learn/save").get_json()["step"] == "saved"

    look = c.get("/api/lookup?code=SKU-99812").get_json()       # scanned barcode now finds the board
    assert look["taught"] and look["parts"] == 5

    # verify a short board -> operator confirms -> fail prompt
    cam.frame = demo.kitted(bare, bolts=3)
    c.post("/api/start", json={"board_id": look["board_id"], "order_ref": "S98993"})
    time.sleep(0.6)
    rec = c.post("/api/stop").get_json()
    assert rec["result"] == "FAIL"
    assert rec["operator_prompt"] == "Review despatch list and verify all items are present"

    # verify a complete board -> auto-confirms on stable PASS -> pass prompt
    cam.frame = demo.kitted(bare)
    c.post("/api/start", json={"board_id": look["board_id"], "order_ref": "S98993"})
    for _ in range(60):
        if st.mode == "idle" and st.last_record:
            break
        time.sleep(0.05)
    s_ = c.get("/api/status").get_json()
    assert s_["last_result"] == "PASS" and s_["prompt"] == "Now ready to bag and package kit"
