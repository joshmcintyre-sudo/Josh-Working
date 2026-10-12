"""Grid parts (24 x M6 nylocs), mirror-image LH/RH brackets, and boxes drawn in learn mode."""
import time

import cv2
import numpy as np
import pytest

import nutboard
from lighting import CONDITIONS
from pokayoke.app import DEFAULTS, _merge, create_app
from pokayoke.inspector import Inspector
from pokayoke.station import FileCamera, Station
from test_inspector import moved

MISS = [(2, 5), (3, 1), (4, 6)]


@pytest.fixture(scope="module")
def insp(tmp_path_factory):
    return Inspector(nutboard.build(tmp_path_factory.mktemp("nuts")))


def comp(res, label):
    return next(c for c in res.components if c.label == label)


@pytest.mark.parametrize("cond", ["normal", "dim_50", "warm_wb", "gradient_lr", "soft_shadow", "exposure_curve", "noisy"])
def test_grid_counts_and_names_empty_cells(insp, cond):
    full, _ = insp.inspect(CONDITIONS[cond](nutboard.kitted()))
    assert full.passed and comp(full, "M6 nyloc nut").found == 24, cond
    res, _ = insp.inspect(CONDITIONS[cond](nutboard.kitted(missing=MISS)))
    nuts = comp(res, "M6 nyloc nut")
    assert (nuts.found, nuts.status) == (21, "SHORT")
    assert nuts.empty_cells == [[2, 5], [3, 1], [4, 6]] and nuts.grid == [4, 6]
    assert nuts.message.endswith("(21/24) - empty: R2C5, R3C1, R4C6")


def test_grid_survives_board_moved(insp):
    res, _ = insp.inspect(moved(nutboard.kitted(missing=[(1, 1)])))
    assert comp(res, "M6 nyloc nut").empty_cells == [[1, 1]]


def test_grid_wrong_colour_nuts_not_counted(insp):
    assert comp(insp.inspect(nutboard.kitted(black_nuts=True))[0], "M6 nyloc nut").found == 0


@pytest.mark.parametrize("cond", ["normal", "dim_50", "warm_wb", "gradient_lr", "soft_shadow", "noisy"])
def test_lh_rh_swap_is_wrong_part_and_normal_is_ok(insp, cond):
    ok, _ = insp.inspect(CONDITIONS[cond](nutboard.kitted()))
    assert ok.passed, [c.message for c in ok.problems]
    res, _ = insp.inspect(CONDITIONS[cond](nutboard.kitted(swap=True)))
    for side in ("Bracket LH", "Bracket RH"):
        c = comp(res, side)
        assert c.status == "WRONG_PART" and "mirrored" in c.message, (cond, c.message)


def test_annotated_view_marks_empty_cells(insp):
    from pokayoke.inspector import annotate, RED
    res, view = insp.inspect(nutboard.kitted(missing=[(1, 1)]))
    out = annotate(view, res)
    x, y = nutboard.GX + nutboard.CELL // 2, nutboard.GY + nutboard.CELL // 2       # centre of R1C1
    assert tuple(int(v) for v in out[y, x]) == RED


# ---- learn mode: boxes and layouts
@pytest.fixture()
def learn(tmp_path):
    cam = FileCamera("x")
    cam.frame = nutboard.bare()
    st = Station(_merge(DEFAULTS, {"boards_dir": str(tmp_path / "b"), "results_dir": str(tmp_path / "r"), "fps": 10,
                                   "stable_frames": 2, "auto_stop_pass_seconds": 0, "learn_repeats": 1}), cam)
    c = create_app(st).test_client()
    c.post("/api/learn/start", json={"code": "PY-NUTS-02", "name": "Nyloc grid"})
    c.post("/api/learn/capture")
    yield st, cam, c
    st.cancel()


def test_learn_grid_with_drawn_box_then_verify(learn):
    st, cam, c = learn
    cam.frame = nutboard.kitted(lh=False, rh=False)
    r = c.post("/api/learn/capture").get_json()
    assert r["step"] == "name" and r["proposal"]                       # auto box found the nuts
    grid_box = [nutboard.GX, nutboard.GY, 6 * nutboard.CELL, 4 * nutboard.CELL]   # operator draws exactly the grid
    r = c.post("/api/learn/part", json={"label": "M6 nyloc nut", "material": "steel", "roi": grid_box,
                                        "layout": "grid", "rows": 4, "cols": 6}).get_json()
    p = r["parts"][-1]
    assert p["roi"] == grid_box and p["grid"] == [4, 6] and p["qty"] == 24 and p["method"] == "grid"
    cam.frame = nutboard.kitted()
    r = c.post("/api/learn/capture").get_json()
    c.post("/api/learn/part", json={"label": "Bracket LH", "material": "black", "roi": [140, 140, 170, 140], "layout": "single"})
    r = c.post("/api/learn/capture").get_json()                        # nothing new placed -> operator draws it
    assert r["step"] == "name" and r["proposal"] is None and "drag a box" in r["message"]
    r = c.post("/api/learn/part", json={"label": "Bracket RH", "material": "black"}).get_json()
    assert r["step"] == "name" and "Drag a box" in r["message"]       # refused without a box
    r = c.post("/api/learn/part", json={"label": "Bracket RH", "material": "black", "roi": [390, 140, 5, 5]}).get_json()
    assert "too small" in r["message"]
    r = c.post("/api/learn/part", json={"label": "Bracket RH", "material": "black", "roi": [390, 140, 170, 140]}).get_json()
    assert r["step"] == "part" and len(r["parts"]) == 3
    assert c.post("/api/learn/parts_done").get_json()["step"] == "done"
    assert c.post("/api/learn/save").get_json()["step"] == "saved"

    cam.frame = nutboard.kitted(missing=MISS)
    c.post("/api/start", json={"board_id": "PY-NUTS-02", "order_ref": "W234566", "operator": "JM"})
    time.sleep(0.6)
    rec = c.post("/api/stop").get_json()
    nuts = next(x for x in rec["inspection"]["components"] if x["label"] == "M6 nyloc nut")
    assert nuts["found"] == 21 and nuts["empty_cells"] == [[2, 5], [3, 1], [4, 6]] and "R2C5" in nuts["message"]
    cam.frame = nutboard.kitted(swap=True)
    c.post("/api/start", json={"board_id": "PY-NUTS-02", "order_ref": "W234567", "operator": "JM"})
    time.sleep(0.6)
    rec = c.post("/api/stop").get_json()
    assert rec["result"] == "FAIL" and sum("mirrored" in x["message"] for x in rec["inspection"]["components"]) == 2


def test_bad_grid_refused():
    from pokayoke.board import Component
    with pytest.raises(ValueError):
        Component("g", "Nut", [0, 0, 100, 100], method="grid", grid_rows=0, grid_cols=6)
    assert Component("g", "Nut", [0, 0, 100, 100], method="grid", grid_rows=4, grid_cols=6, expected_count=3).expected_count == 24
