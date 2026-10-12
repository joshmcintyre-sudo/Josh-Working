import json
import re
import time

import pytest

from pokayoke import demo
from pokayoke.app import DEFAULTS, _merge, create_app
from pokayoke.launcher import to_http
from pokayoke.station import FileCamera, Station

OPS = "https://ops-hub-v2.lovable.app"


@pytest.fixture()
def rig(tmp_path):
    demo.build(tmp_path / "boards", tmp_path / "imgs")
    cam = FileCamera("x")
    cam.frame = demo.kitted(demo.bare_board())
    s = _merge(DEFAULTS, {"boards_dir": str(tmp_path / "boards"), "results_dir": str(tmp_path / "res"),
                          "fps": 10, "stable_frames": 2, "auto_stop_pass_seconds": 0})
    st = Station(s, cam)
    yield st, cam, create_app(st).test_client()
    st.cancel()


def launch_of(html: bytes) -> dict | None:
    m = re.search(rb"const LAUNCH = (.*?);\n", html)
    return json.loads(m.group(1))


def test_launch_page_carries_context_and_only_trusted_return(rig):
    st, cam, c = rig
    ok = launch_of(c.get(f"/launch?launch_id=3f2a-9c&order=w234566&model=DEMO-HILUX-01&operator=JM"
                         f"&checklist=Final%20QC&step=Poka-yoke&return={OPS}/mes%3Forder%3DW234566").data)
    assert ok["order"] == "W234566" and ok["model"] == "DEMO-HILUX-01" and ok["launch_id"] == "3f2a-9c"
    assert ok["return_url"] == f"{OPS}/mes?order=W234566"
    evil = launch_of(c.get("/launch?launch_id=x&order=W234566&return=https://evil.example/phish").data)
    assert evil["return_url"] == ""
    bad = launch_of(c.get("/launch?order=HELLO").data)
    assert "not a valid order" in bad["error"]
    assert launch_of(c.get("/").data) is None


def test_ping_cors_for_ops_hub_only(rig):
    st, cam, c = rig
    r = c.options("/api/ping", headers={"Origin": OPS, "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 204
    assert r.headers["Access-Control-Allow-Origin"] == OPS
    assert r.headers["Access-Control-Allow-Private-Network"] == "true"
    r = c.get("/api/ping", headers={"Origin": "https://evil.example"})
    assert r.get_json()["ok"] and "Access-Control-Allow-Origin" not in r.headers


def test_launch_id_on_started_and_completed_records(rig):
    st, cam, c = rig
    sent = []
    st.exporter.targets = lambda: ["webhook"]
    st.exporter.enqueue = lambda rec, path, img, only=None: sent.append(json.loads(open(path).read())) or "queued"
    launch = {"launch_id": "3f2a-9c", "source": "ops_hub", "step": "Poka-yoke", "checklist": "Final QC",
              "model": "DEMO-HILUX-01", "return_url": OPS, "junk": "x" * 500}
    st.s["export"]["webhook"]["enabled"] = True
    c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": "W234566", "operator": "JM", "launch": launch})
    time.sleep(0.5)
    rec = c.post("/api/stop").get_json()
    assert rec["result"] == "PASS" and rec["launch_id"] == "3f2a-9c"
    assert "junk" not in rec["launch"] and "return_url" not in rec["launch"]
    assert [e["event"] for e in sent] == ["started", "completed"]
    assert all(e["launch_id"] == "3f2a-9c" for e in sent)


def test_protocol_link_maps_to_local_launch_page():
    assert to_http("pokayoke://launch?launch_id=a1&order=W234566&model=X%20Y", "http://127.0.0.1:8080") == \
        "http://127.0.0.1:8080/launch?launch_id=a1&order=W234566&model=X%20Y"
    assert to_http("pokayoke://", "http://127.0.0.1:8080") == "http://127.0.0.1:8080/"


def test_standalone_check_without_key_is_not_queued(rig):
    st, cam, c = rig
    st.s["export"]["webhook"].update({"enabled": True, "url": "http://127.0.0.1:9/x", "token": ""})
    st.exporter.webhook = st.s["export"]["webhook"]
    c.post("/api/start", json={"board_id": "DEMO-HILUX-01", "order_ref": "W234566", "operator": "JM"})
    time.sleep(0.4)
    c.post("/api/stop")
    assert not list((st.results_dir / "outbox" / "pending").glob("*.json"))
    assert c.get("/api/log").get_json()[0]["export_status"].startswith("not sent: standalone")
