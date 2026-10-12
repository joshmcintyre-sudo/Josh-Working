"""Detection must hold across shop-floor lighting, and refuse to judge images it can't see."""
import time

import numpy as np
import pytest

from lighting import CONDITIONS
from pokayoke import demo
from pokayoke.app import DEFAULTS, _merge, create_app
from pokayoke.board import BoardLibrary
from pokayoke.inspector import Inspector
from pokayoke.learn import find_added_part
from pokayoke.station import FileCamera, Station
from test_inspector import moved

CASES = {"good": ({}, set()), "no_bracket": ({"bracket": False}, {"Mounting bracket LH"}),
         "no_seal": ({"seal": False}, {"Door seal 450mm"}), "no_loom": ({"loom": False}, {"Wiring loom bag"}),
         "bolts_4": ({"bolts": 4}, {"M8 x 25 flange bolt"}), "bolts_0": ({"bolts": 0}, {"M8 x 25 flange bolt"})}


@pytest.fixture(scope="module")
def insp(tmp_path_factory):
    d = tmp_path_factory.mktemp("light")
    demo.build(d / "b", d / "i")
    return Inspector(BoardLibrary(d / "b").get("DEMO-HILUX-01"))


@pytest.mark.parametrize("cond", list(CONDITIONS))
@pytest.mark.parametrize("case", list(CASES))
def test_detection_holds_under_lighting(insp, cond, case):
    kw, expected = CASES[case]
    res, _ = insp.inspect(CONDITIONS[cond](demo.kitted(demo.bare_board(), **kw)))
    assert res.board_ok, (cond, case, res.message)
    glare = {c.label for c in res.problems if c.status == "GLARE"}
    real = {c.label for c in res.problems if c.status != "GLARE"}
    assert real == expected, (cond, case, [c.message for c in res.problems])
    if glare:                       # a part it can't see is never a PASS and never a false MISSING
        assert not res.passed and not res.lighting_ok and cond == "bright_clipped"
    if case == "bolts_4":
        assert next(c.found for c in res.components if c.label.startswith("M8")) == 4


@pytest.mark.parametrize("name,fn", [
    ("dim+warm+gradient+shadow", lambda im: CONDITIONS["soft_shadow"](CONDITIONS["gradient_lr"](CONDITIONS["warm_wb"](CONDITIONS["dim_50"](im))))),
    ("moved+spotlight+noise", lambda im: CONDITIONS["noisy"](CONDITIONS["spotlight"](moved(im)))),
    ("moved+cool+curve", lambda im: CONDITIONS["exposure_curve"](CONDITIONS["cool_wb"](moved(im, -30, 20, -4, 1.03)))),
])
def test_combined_conditions(insp, name, fn):
    for case, (kw, expected) in CASES.items():
        res, _ = insp.inspect(fn(demo.kitted(demo.bare_board(), **kw)))
        assert res.board_ok and {c.label for c in res.problems} == expected, (name, case, res.message)


@pytest.mark.parametrize("cond", list(CONDITIONS))
def test_wrong_board_rejected_in_any_light(insp, cond):
    res, _ = insp.inspect(CONDITIONS[cond](demo.kitted(demo.bare_board(seed=99))))
    assert not res.board_ok and not res.passed


@pytest.mark.parametrize("name,fn,word", [
    ("pitch_dark", lambda im: (im * 0.04).astype(np.uint8), "too dark"),
    ("white_out", lambda im: np.clip(im.astype(np.float32) * 5, 0, 255).astype(np.uint8), "over-exposed"),
    ("lens_covered", lambda im: np.full_like(im, 40), "lens is covered"),
])
def test_unusable_image_says_check_never_pass_or_fail(insp, name, fn, word):
    for kw, _ in CASES.values():
        res, _ = insp.inspect(fn(demo.kitted(demo.bare_board(), **kw)))
        assert not res.passed and not res.lighting_ok and word in res.message, (name, res.message)


def test_learn_finds_part_when_light_changes_between_captures():
    bare = demo.bare_board()
    prev = CONDITIONS["normal"](demo.kitted(bare, bracket=False, seal=False, loom=False, bolts=0))
    curr = CONDITIONS["warm_wb"](CONDITIONS["dim_50"](demo.kitted(bare, bracket=False, seal=True, loom=False, bolts=0)))
    x, y, w, h = find_added_part(prev, curr)
    sx, sy, sw, sh = [440, 120, 470, 60]                     # the seal's real box
    ix = max(0, min(x + w, sx + sw) - max(x, sx)); iy = max(0, min(y + h, sy + sh) - max(y, sy))
    assert ix * iy / (w * h + sw * sh - ix * iy) > 0.5, (x, y, w, h)


def test_station_records_no_result_in_bad_light(tmp_path):
    demo.build(tmp_path / "b", tmp_path / "i")
    cam = FileCamera("x")
    cam.frame = (demo.kitted(demo.bare_board()) * 0.04).astype(np.uint8)
    st = Station(_merge(DEFAULTS, {"boards_dir": str(tmp_path / "b"), "results_dir": str(tmp_path / "r"),
                                   "fps": 10, "stable_frames": 2, "auto_stop_pass_seconds": 0}), cam)
    c = create_app(st).test_client()
    c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": "W234566", "operator": "JM"})
    time.sleep(0.5)
    live = c.get("/api/status").get_json()["result"]
    assert live["lighting_ok"] is False and "too dark" in live["message"]
    rec = c.post("/api/stop").get_json()
    assert rec["vision_result"] == "NO_RESULT" and rec["result"] == "NO_RESULT"
    st.cancel()
