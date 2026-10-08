"""Web app: upload footage -> pick area + segments -> download heat map / spaghetti PDF.

Run:  streamlit run app.py
"""
import json
import os
import tempfile

import cv2
import pandas as pd
import streamlit as st

from operator_heatmap.pipeline import Options, report, track
from operator_heatmap.projection import View360
from operator_heatmap.roi import ROI, preview
from operator_heatmap.segments import fmt_ts
from operator_heatmap.tracker import VideoSource

st.set_page_config(page_title="Operator Heat Map", layout="wide")
st.title("Operator movement heat map + spaghetti diagram")

WORK = os.path.join(tempfile.gettempdir(), "operator_heatmap")
os.makedirs(WORK, exist_ok=True)
CAMERAS = {"Fixed camera": "fixed",
           "360 ceiling fisheye (round image looking down)": "fisheye",
           "360 panorama / equirectangular (Insta360, GoPro Max)": "360"}

# ---------------------------------------------------------------- 1. footage
st.header("1. Footage")
c1, c2 = st.columns([2, 1])
with c1:
    up = st.file_uploader("Upload video (mp4 / mov / avi / mkv)", type=["mp4", "mov", "avi", "mkv", "m4v"])
    local = st.text_input("...or path to a video already on this machine / network share", "")
with c2:
    camera = CAMERAS[st.radio("Camera type", list(CAMERAS))]
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
mount_height, lens_fov = 0.0, 180.0
if camera == "360":
    st.subheader("360 view - aim a virtual camera at the work area")
    v1, v2, v3 = st.columns(3)
    view.yaw = v1.slider("Yaw (look left/right)", -180, 180, 0)
    view.pitch = v2.slider("Pitch (look down/up)", -90, 30, -20)
    view.fov = v3.slider("Field of view", 60, 150, 100)
elif camera == "fisheye":
    f1, f2 = st.columns(2)
    mount_height = f1.number_input("Camera height above floor (m) - gives metres walked, 0 = skip",
                                   0.0, 30.0, 0.0, 0.1)
    lens_fov = f2.number_input("Lens field of view (deg) - check camera datasheet, usually 180-187",
                               120.0, 220.0, 180.0, 1.0)

src = VideoSource(video_path, camera, view)
duration = src.duration
st.caption(f"{os.path.basename(video_path)} - {fmt_ts(duration)} long, {src.fps:.1f} fps, "
           f"analysed view {src.size[0]}x{src.size[1]}")

# ---------------------------------------------------------------- 2. area
st.header("2. Area to analyse (optional)")
st.caption("Ignore parts of the view that confuse the count (offices, walkways outside the cell, mezzanine, "
           "reflections) - and the smaller the area, the faster the analysis. Live preview below.")
a1, a2 = st.columns(2)
with a1:
    st.markdown("**Rectangles** - % of the image, 0,0 = top-left")
    rects = st.data_editor(
        st.session_state.get("rects", pd.DataFrame(columns=["use", "left %", "top %", "right %", "bottom %"])),
        num_rows="dynamic", key="rects_ed", width="stretch",
        column_config={"use": st.column_config.SelectboxColumn("Use", options=["include", "exclude"], required=True),
                       **{c: st.column_config.NumberColumn(c, min_value=0, max_value=100)
                          for c in ["left %", "top %", "right %", "bottom %"]}})
with a2:
    sectors = pd.DataFrame(columns=["use", "from deg", "to deg", "inner %", "outer %"])
    if camera == "fisheye":
        st.markdown("**Pie slices** - 0 deg = 12 o'clock, clockwise; radius % from centre to edge")
        sectors = st.data_editor(
            sectors, num_rows="dynamic", key="sectors_ed", width="stretch",
            column_config={"use": st.column_config.SelectboxColumn("Use", options=["include", "exclude"], required=True),
                           "from deg": st.column_config.NumberColumn(min_value=0, max_value=360),
                           "to deg": st.column_config.NumberColumn(min_value=0, max_value=360),
                           "inner %": st.column_config.NumberColumn(min_value=0, max_value=100),
                           "outer %": st.column_config.NumberColumn(min_value=0, max_value=100)})
    roi_file = st.file_uploader("...or upload area JSON (polygons in pixels)", type=["json"], key="roi_json")

spec = {"include": [], "exclude": []}
for r in rects.dropna().itertuples(index=False):
    spec[r[0]].append({"rect": [float(v) for v in r[1:5]]})
for r in sectors.dropna().itertuples(index=False):
    spec[r[0]].append({"sector": [float(v) for v in r[1:5]]})
if roi_file is not None:
    extra = json.load(roi_file)
    spec["include"] += extra.get("include", [])
    spec["exclude"] += extra.get("exclude", [])
try:
    roi = ROI.from_spec(spec, src.size)
except ValueError as e:
    st.error(str(e))
    roi = None
if roi is not None:
    st.caption(f"Analysing {roi.coverage:.0%} of the view")

# ---------------------------------------------------------------- 3. segments
st.header("3. Time segments to analyse")
if "segs" not in st.session_state:
    st.session_state.segs = pd.DataFrame([{"start": "00:00:00", "end": fmt_ts(duration), "note": "whole clip"}])
segs_df = st.data_editor(st.session_state.segs, num_rows="dynamic", width="stretch",
                         column_config={"start": st.column_config.TextColumn("Start (hh:mm:ss)"),
                                        "end": st.column_config.TextColumn("End (hh:mm:ss)"),
                                        "note": st.column_config.TextColumn("Note (e.g. Shift A, changeover)")})
seg_text = ", ".join(f"{r.start}-{r.end}" for r in segs_df.itertuples() if r.start and r.end)

scrub = st.slider("Scrub to preview (seconds)", 0.0, max(duration - 0.1, 0.1), 0.0, 1.0)
frame = src.frame_at(scrub)
st.image(cv2.cvtColor(preview(frame, roi), cv2.COLOR_BGR2RGB),
         caption=f"Frame at {fmt_ts(scrub)} - dimmed = ignored, orange outline = analysed", width="stretch")
base_mode = st.radio("PDF background photo", ["Empty floor (operators removed)", "This preview frame"], horizontal=True)
src.close()

# ---------------------------------------------------------------- 4. settings
st.header("4. Settings")
s1, s2, s3, s4, s5 = st.columns(5)
operators = s1.number_input("Operators working this area (0 = auto)", 0, 100, 0,
                            help="If you know the headcount, broken tracks are merged until this many remain")
backend = s2.selectbox("Detector", ["yolo", "motion"],
                       help="yolo = AI person detection (best). motion = background subtraction (no AI, quick)")
model = s3.selectbox("YOLO model", ["yolo11n.pt", "yolo11s.pt", "yolo11m.pt"],
                     help="n = fastest, s = better for small/overhead people, m = most accurate (GPU)")
sample_fps = s4.slider("Frames analysed per second", 1, 15, 5, help="Lower = faster. 3-5 is plenty for walking")
page = s5.selectbox("PDF page size", ["A3", "A4"])
crop_output = st.checkbox("Zoom PDF to the selected area", True, disabled=roi is None)
cfg = st.file_uploader("Optional: zones + calibration JSON (adds dwell-per-zone, trips between zones, metres walked)",
                       type=["json"])
cfg_path = ""
if cfg is not None:
    cfg_path = os.path.join(WORK, "zones.json")
    with open(cfg_path, "wb") as fh:
        fh.write(cfg.getbuffer())


def options() -> Options:
    return Options(video=video_path, out_dir=os.path.join(WORK, "out"), title=title, camera=camera,
                   segments=seg_text, base_time=fmt_ts(scrub) if base_mode.startswith("This") else "",
                   backend=backend, model=model, sample_fps=sample_fps, config=cfg_path, page=page,
                   yaw=view.yaw, pitch=view.pitch, fov=view.fov, operators=int(operators),
                   mount_height=mount_height, lens_fov=lens_fov,
                   roi=json.dumps(spec) if roi is not None else "", crop_output=crop_output)


# ---------------------------------------------------------------- 5. run
st.header("5. Analyse")
if st.button("Run analysis", type="primary"):
    bar = st.progress(0.0, "Detecting and tracking operators...")
    try:
        st.session_state.tracks = track(options(), lambda p: bar.progress(p, f"Detecting and tracking... {p:.0%}"))
        st.session_state.labels = {}
    except Exception as e:  # surface parse / video errors to the user
        st.error(str(e))
        st.stop()
    bar.empty()

if "tracks" in st.session_state:
    tr = st.session_state.tracks
    out = report(options(), tr, st.session_state.get("labels"))
    st.success(f"{len(out['analysis'].paths)} operators identified from {len(out['tracklets'])} raw tracks")
    d1, d2, d3 = st.columns(3)
    with open(out["pdf"], "rb") as fh:
        d1.download_button("Download PDF", fh.read(), os.path.basename(out["pdf"]), "application/pdf", type="primary")
    with open(out["csv"], "rb") as fh:
        d2.download_button("Raw track CSV", fh.read(), os.path.basename(out["csv"]), "text/csv")
    with open(out["headcount_csv"], "rb") as fh:
        d3.download_button("Headcount CSV", fh.read(), os.path.basename(out["headcount_csv"]), "text/csv")

    t1, t2, t3 = st.tabs(["Combined", "Heat map", "Spaghetti"])
    for tab, key in ((t1, "combined"), (t2, "heatmap"), (t3, "spaghetti")):
        tab.image(out[key], width="stretch")

    # ------------------------------------------------------------ 6. relabel
    st.header("6. Check / name operators (optional)")
    st.caption("Each raw track with a snapshot. Type the same name on tracks that are the same person to merge them, "
               "a real name or role (e.g. 'Welder', 'Team lead'), or 'ignore' to drop a track "
               "(visitor, forklift driver, false detection). Then click Rebuild PDF - no re-processing of the video.")
    rows = [r for r in out["tracklets"] if r["track"] in tr.thumbs and r["seen_s"] >= 1.0]
    edits = {}
    per_row = 6
    for i in range(0, len(rows), per_row):
        cols = st.columns(per_row)
        for col, r in zip(cols, rows[i:i + per_row]):
            col.image(cv2.cvtColor(tr.thumbs[r["track"]], cv2.COLOR_BGR2RGB),
                      caption=f"#{r['track']}  {fmt_ts(r['start_s'])}-{fmt_ts(r['end_s'])}")
            edits[r["track"]] = col.text_input("Operator", st.session_state.get("labels", {}).get(r["track"], r["operator"]),
                                               key=f"lbl{r['track']}", label_visibility="collapsed")
    if st.button("Rebuild PDF with these names"):
        st.session_state.labels = {k: v for k, v in edits.items() if v}
        st.rerun()
