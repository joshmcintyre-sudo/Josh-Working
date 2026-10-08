"""Web app: upload footage -> pick segments -> download heat map / spaghetti PDF.

Run:  streamlit run app.py
"""
import os
import tempfile

import cv2
import pandas as pd
import streamlit as st

from operator_heatmap import Options, run
from operator_heatmap.projection import View360
from operator_heatmap.segments import fmt_ts, parse_ts
from operator_heatmap.tracker import VideoSource

st.set_page_config(page_title="Operator Heat Map", layout="wide")
st.title("Operator movement heat map + spaghetti diagram")

WORK = os.path.join(tempfile.gettempdir(), "operator_heatmap")
os.makedirs(WORK, exist_ok=True)

# ---------------------------------------------------------------- 1. footage
st.header("1. Footage")
c1, c2 = st.columns([2, 1])
with c1:
    up = st.file_uploader("Upload video (mp4 / mov / avi / mkv)", type=["mp4", "mov", "avi", "mkv", "m4v"])
    local = st.text_input("...or path to a video already on this machine / network share", "")
with c2:
    camera = st.radio("Camera type", ["fixed", "360"], horizontal=True,
                      help="360 = equirectangular export (Insta360 / GoPro Max / Ricoh Theta)")
    title = st.text_input("Report title", "")

video_path = None
if up is not None:
    video_path = os.path.join(WORK, up.name)
    if not os.path.exists(video_path) or os.path.getsize(video_path) != up.size:
        with open(video_path, "wb") as fh:
            fh.write(up.getbuffer())
elif local and os.path.exists(local):
    video_path = local

if not video_path:
    st.info("Upload a clip or enter a path to start.")
    st.stop()

view = View360()
if camera == "360":
    st.subheader("360 view - aim a virtual camera at the work area")
    v1, v2, v3 = st.columns(3)
    view.yaw = v1.slider("Yaw (look left/right)", -180, 180, 0)
    view.pitch = v2.slider("Pitch (look down/up)", -90, 30, -20)
    view.fov = v3.slider("Field of view", 60, 150, 100)

src = VideoSource(video_path, camera, view)
duration = src.duration
st.caption(f"{os.path.basename(video_path)} - {fmt_ts(duration)} long, {src.fps:.1f} fps, "
           f"analysed view {src.size[0]}x{src.size[1]}")

# ---------------------------------------------------------------- 2. segments
st.header("2. Pick the time segments to analyse")
if "segs" not in st.session_state:
    st.session_state.segs = pd.DataFrame([{"start": "00:00:00", "end": fmt_ts(duration), "note": "whole clip"}])
segs_df = st.data_editor(st.session_state.segs, num_rows="dynamic", use_container_width=True,
                         column_config={"start": st.column_config.TextColumn("Start (hh:mm:ss)"),
                                        "end": st.column_config.TextColumn("End (hh:mm:ss)"),
                                        "note": st.column_config.TextColumn("Note (e.g. Shift A, changeover)")})
seg_text = ", ".join(f"{r.start}-{r.end}" for r in segs_df.itertuples() if r.start and r.end)

scrub = st.slider("Scrub to preview (seconds)", 0.0, max(duration - 0.1, 0.1), 0.0, 1.0)
st.image(cv2.cvtColor(src.frame_at(scrub), cv2.COLOR_BGR2RGB), caption=f"Frame at {fmt_ts(scrub)}",
         use_container_width=True)
base_mode = st.radio("PDF background photo", ["Empty floor (operators removed)", "This preview frame"], horizontal=True)
src.close()

# ---------------------------------------------------------------- 3. settings
st.header("3. Settings")
s1, s2, s3, s4 = st.columns(4)
backend = s1.selectbox("Detector", ["yolo", "motion"],
                       help="yolo = AI person detection (best). motion = background subtraction (no AI, quick)")
model = s2.selectbox("YOLO model", ["yolo11n.pt", "yolo11s.pt", "yolo11m.pt"],
                     help="n = fastest, m = most accurate (use with a GPU)")
sample_fps = s3.slider("Frames analysed per second", 1, 15, 5)
page = s4.selectbox("PDF page size", ["A3", "A4"])
cfg = st.file_uploader("Optional: zones + calibration JSON (adds dwell-per-zone, trips between zones, metres walked)",
                       type=["json"])
cfg_path = ""
if cfg is not None:
    cfg_path = os.path.join(WORK, "zones.json")
    with open(cfg_path, "wb") as fh:
        fh.write(cfg.getbuffer())

# ---------------------------------------------------------------- 4. run
st.header("4. Analyse")
if st.button("Run analysis", type="primary"):
    bar = st.progress(0.0, "Detecting and tracking operators...")
    try:
        out = run(Options(video=video_path, out_dir=os.path.join(WORK, "out"), title=title, camera=camera,
                          segments=seg_text, base_time=fmt_ts(scrub) if base_mode.startswith("This") else "", backend=backend, model=model,
                          sample_fps=sample_fps, config=cfg_path, page=page,
                          yaw=view.yaw, pitch=view.pitch, fov=view.fov),
                  progress=lambda p: bar.progress(p, f"Detecting and tracking operators... {p:.0%}"))
    except Exception as e:  # surface parse / video errors to the user
        st.error(str(e))
        st.stop()
    bar.empty()
    st.success("Done")
    with open(out["pdf"], "rb") as fh:
        st.download_button("Download PDF", fh.read(), os.path.basename(out["pdf"]), "application/pdf", type="primary")
    with open(out["csv"], "rb") as fh:
        st.download_button("Download raw track CSV", fh.read(), os.path.basename(out["csv"]), "text/csv")
    t1, t2, t3 = st.tabs(["Combined", "Heat map", "Spaghetti"])
    for tab, key in ((t1, "combined"), (t2, "heatmap"), (t3, "spaghetti")):
        tab.image(out[key], use_container_width=True)
