"""Parts that are always a given colour/material: wrong colour, hands and stray objects must not pass."""
import cv2
import pytest

from lighting import CONDITIONS
from pokayoke import colour, demo
from pokayoke.board import BoardLibrary
from pokayoke.inspector import Inspector

SKIN = (120, 150, 200)          # BGR: a hand / glove in the pocket


@pytest.fixture(scope="module")
def insp(tmp_path_factory):
    d = tmp_path_factory.mktemp("colour")
    demo.build(d / "b", d / "i")
    return Inspector(BoardLibrary(d / "b").get("DEMO-HILUX-01"))


def by_label(res):
    return {c.label: c for c in res.components}


def board(**kw):
    return demo.kitted(demo.bare_board(), **kw)


def white_seal(img):            # a white seal strip where the black one belongs
    cv2.rectangle(img, (450, 130), (900, 170), (240, 240, 240), -1); return img


def black_bracket(img):         # black-plastic bracket where the zinc one belongs
    cv2.rectangle(img, (120, 120), (330, 230), (30, 30, 32), -1); return img


def zinc_bolts(img):            # bright zinc bolts where black-oxide ones belong
    for (x, y) in demo.BOLTS:
        cv2.circle(img, (x, y), 14, (185, 185, 190), -1)
    return img


def red_bag(img):
    cv2.rectangle(img, (950, 100), (1180, 330), (40, 40, 200), -1); return img


def black_ties(img):
    cv2.rectangle(img, (660, 400), (860, 450), (25, 25, 25), -1); return img


@pytest.mark.parametrize("name,make,label,should,looks", [
    ("white seal in black slot", lambda: white_seal(board(seal=False)), "Door seal 450mm", "black", "white"),
    ("black bracket for zinc", lambda: black_bracket(board(bracket=False)), "Mounting bracket LH", "steel", "black"),
    ("zinc bolts for black", lambda: zinc_bolts(board(bolts=0)), "M8 x 25 flange bolt", "black", "grey"),
    ("red bag for blue", lambda: red_bag(board(loom=False)), "Wiring loom bag", "blue", "red"),
    ("black ties for white", lambda: black_ties(board(ties=False)), "Cable tie bundle", "white", "black"),
])
def test_wrong_colour_part_is_flagged(insp, name, make, label, should, looks):
    res, _ = insp.inspect(make())
    c = by_label(res)[label]
    assert not res.passed
    assert c.status == "WRONG_PART", (name, c.status, c.message)
    assert f"should be {should}" in c.message and f"looks {looks}" in c.message, c.message
    assert {x.label for x in res.problems} == {label}, [x.message for x in res.problems]


@pytest.mark.parametrize("cond", ["dim_50", "warm_wb", "gradient_lr", "soft_shadow", "exposure_curve"])
def test_wrong_colour_caught_in_bad_light(insp, cond):
    res, _ = insp.inspect(CONDITIONS[cond](white_seal(board(seal=False))))
    assert by_label(res)["Door seal 450mm"].status == "WRONG_PART", cond


def test_hand_in_empty_bracket_pocket_is_not_a_bracket(insp):
    img = board(bracket=False)
    cv2.ellipse(img, (225, 175), (100, 50), 0, 0, 360, SKIN, -1)
    c = by_label(insp.inspect(img)[0])["Mounting bracket LH"]
    assert c.status != "OK" and c.found == 0, c.message


def test_finger_in_bolt_pocket_not_counted(insp):
    img = board(bolts=4)
    cv2.ellipse(img, (480, 520), (22, 14), 0, 0, 360, SKIN, -1)      # finger-tip where bolt 5 would be
    c = by_label(insp.inspect(img)[0])["M8 x 25 flange bolt"]
    assert c.found == 4 and c.status == "SHORT", c.message


def test_good_board_and_suggestions(insp):
    res, _ = insp.inspect(board())
    assert res.passed, [c.message for c in res.problems]
    seen = {c.label: colour.suggest(c.colour_lab) for c in insp.board.components}
    assert seen == {"Mounting bracket LH": "steel", "Door seal 450mm": "black", "Wiring loom bag": "colour",
                    "M8 x 25 flange bolt": "black", "Cable tie bundle": "white"}


def test_old_board_without_colour_learning_still_works(tmp_path):
    demo.build(tmp_path / "b", tmp_path / "i")
    lib = BoardLibrary(tmp_path / "b")
    b = lib.get("DEMO-HILUX-01")
    for c in b.components:                       # as saved by an earlier version
        c.material, c.colour_lab, c.ref_fg_area, c.ref_mat_area = "auto", None, 0.0, 0.0
    b.save()
    res, _ = Inspector(lib.get("DEMO-HILUX-01")).inspect(board(seal=False))
    assert {c.label for c in res.problems} == {"Door seal 450mm"}


def test_station_keeps_wrong_part_through_vote_and_saves_it(tmp_path):
    import time
    from pokayoke.app import DEFAULTS, _merge, create_app
    from pokayoke.station import FileCamera, Station
    demo.build(tmp_path / "b", tmp_path / "i")
    cam = FileCamera("x")
    cam.frame = white_seal(board(seal=False))
    st = Station(_merge(DEFAULTS, {"boards_dir": str(tmp_path / "b"), "results_dir": str(tmp_path / "r"),
                                   "fps": 10, "stable_frames": 3, "auto_stop_pass_seconds": 0}), cam)
    c = create_app(st).test_client()
    c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": "W234566", "operator": "JM"})
    time.sleep(0.8)
    rec = c.post("/api/stop").get_json()
    seal = next(x for x in rec["inspection"]["components"] if x["label"] == "Door seal 450mm")
    assert rec["result"] == "FAIL" and seal["status"] == "WRONG_PART" and "looks white" in seal["message"]
    st.cancel()
