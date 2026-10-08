"""Web app: footage -> draw areas + pick segments -> heat map / spaghetti PDF.

Run on Windows: double-click run_windows.bat   (or: streamlit run app.py)
"""
import json
import os
import tempfile

import cv2
import pandas as pd
import streamlit as st

from operator_heatmap.area_draw import area_draw, shapes_to_spec, spec_to_shapes
from operator_heatmap.fisheye import detect_circle
from operator_heatmap.pipeline import Options, report, track
from operator_heatmap.projection import View360
from operator_heatmap.roi import ROI
from operator_heatmap.segments import fmt_ts
from operator_heatmap.tracker import VideoSource, valid_area

st.set_page_config(page_title="Operator Heat Map", layout="wide")
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
LOGO_FILES = ("Utemaster_Wordmark_Primary_White.svg", "Utemaster_Wordmark_Primary_White.png")

# Utemaster brand: Rich Black / White, Black tints, Bronze accent; Aptos (Narrow) = substitutes for
# Beachwood / Neue Montreal. Logo = official file from Box only (never redrawn).
st.markdown("""<style>
  :root { --utm-black:#000000; --utm-white:#FFFFFF; --utm-bronze:#876044; --utm-black-80:#333333;
          --utm-black-60:#666666; --utm-black-40:#999999; --utm-black-20:#CCCCCC; --utm-black-5:#F2F2F2;
          --utm-font-headline:"Beachwood","Aptos Narrow","Arial Narrow","Aptos",sans-serif;
          --utm-font-body:"Neue Montreal","Aptos","Segoe UI",system-ui,sans-serif; }
  html, body, .stMarkdown, p, input, textarea, [data-baseweb="select"] div { font-family: var(--utm-font-body); }
  [data-testid="stIconMaterial"], .material-symbols-rounded { font-family: "Material Symbols Rounded" !important;
      text-transform: none !important; letter-spacing: 0 !important; }
  header[data-testid="stHeader"] { background: transparent; height: 2.2rem; }
  .block-container {padding-top: 2.6rem; padding-bottom: 1rem; max-width: 1500px;}
  h1, h2, h3, [data-testid="stMetricLabel"] p, .stTabs button p, [data-testid="stWidgetLabel"] p {
      font-family: var(--utm-font-headline) !important; text-transform: uppercase; letter-spacing: 0.06em; }
  h1 {font-size: 1.25rem !important; font-weight: 400 !important; margin: 0 !important; padding: 0 !important;}
  h3 {font-size: 0.95rem !important; font-weight: 400 !important; margin: 0.3rem 0 0.1rem 0 !important;
      padding-bottom: 0.3rem !important; border-bottom: 1px solid var(--utm-black-60);}
  [data-testid="stSidebar"] {min-width: 300px; max-width: 300px; background: var(--utm-black);
      border-right: 1px solid var(--utm-black-80);}
  [data-testid="stSidebar"] .block-container {padding-top: 1rem;}
  div[data-testid="stVerticalBlock"] {gap: 0.5rem;}
  .stButton button, .stDownloadButton button, [data-testid="stPopover"] button {
      border-radius: 2px !important;
      text-transform: uppercase; letter-spacing: 0.06em; background: var(--utm-black); color: var(--utm-white);
      border: 1px solid var(--utm-black-40); }
  .stButton button:hover, .stDownloadButton button:hover { border-color: var(--utm-bronze); color: var(--utm-white); }
  .stButton button p, .stDownloadButton button p, [data-testid="stPopover"] button p {
      font-family: var(--utm-font-headline); text-transform: uppercase; letter-spacing: 0.06em; }
  .stButton button[kind="primary"] { background: var(--utm-bronze); border-color: var(--utm-bronze); }
  [data-testid="stWidgetLabel"] p { font-size: 0.78rem !important; white-space: nowrap; }
  input, textarea, [data-baseweb="select"] > div { border-radius: 2px !important; }
  [data-testid="stMetricValue"] { font-family: var(--utm-font-body) !important; }
  .utm-header { display:flex; align-items:center; gap:18px; padding: 4px 0 10px 0;
      border-bottom: 1px solid var(--utm-black-60); margin-bottom: 6px; }
  .utm-header img { width: 170px; }
  .utm-logo-placeholder { border: 1px dashed var(--utm-black-40); color: var(--utm-black-40); padding: 6px 12px;
      font-family: var(--utm-font-headline); letter-spacing: 0.08em; font-size: 0.8rem; }
  .utm-sub { color: var(--utm-black-40); font-size: 0.8rem; text-transform: none; letter-spacing: 0; }
</style>""", unsafe_allow_html=True)


def brand_header(title: str, subtitle: str):
    logo = next((os.path.join(ASSETS, f) for f in LOGO_FILES if os.path.exists(os.path.join(ASSETS, f))), None)
    if logo:
        import base64
        mime = "image/svg+xml" if logo.endswith(".svg") else "image/png"
        with open(logo, "rb") as fh:
            mark = f'<img src="data:{mime};base64,{base64.b64encode(fh.read()).decode()}" alt="Utemaster">'
    else:
        mark = '<span class="utm-logo-placeholder" title="Copy the official logo into the assets folder">[UTEMASTER LOGO]</span>'
    st.markdown(f'<div class="utm-header">{mark}<div><h1>{title}</h1><div class="utm-sub">{subtitle}</div></div></div>',
                unsafe_allow_html=True)

WORK = os.path.join(tempfile.gettempdir(), "operator_heatmap")
os.makedirs(WORK, exist_ok=True)
CAMERAS = {"360 ceiling fisheye (round image)": "fisheye", "Fixed camera": "fixed",
           "360 panorama (Insta360, GoPro Max)": "360"}


@st.cache_resource(show_spinner="Finding the fisheye circle...")
def fisheye_circle(path: str, mtime: float):
    src = VideoSource(path, "fixed")
    try:
        return detect_circle(src._sample_raw(8))
    finally:
        src.close()


# ================================================================ sidebar: footage + settings
with st.sidebar:
    st.markdown("### Footage")
    up = st.file_uploader("Upload video", type=["mp4", "mov", "avi", "mkv", "m4v"], label_visibility="collapsed")
    local = st.text_input("...or file path", "", placeholder=r"C:\Footage\cam3.mp4").strip().strip('"')
    camera = CAMERAS[st.selectbox("Camera", list(CAMERAS))]
    title = st.text_input("Report title", "", placeholder="e.g. Line 3 - Shift A")

    view = View360()
    mount_height, lens_fov = 0.0, 180.0
    if camera == "fisheye":
        c1, c2 = st.columns(2)
        mount_height = c1.number_input("Height (m)", 0.0, 30.0, 0.0, 0.1, help="Lens height above floor -> metres walked. 0 = skip")
        lens_fov = c2.number_input("Lens FOV°", 120.0, 220.0, 180.0, 1.0, help="From camera datasheet, usually 180-187")
    elif camera == "360":
        view.yaw = st.slider("Yaw (left/right)", -180, 180, 0)
        view.pitch = st.slider("Pitch (down/up)", -90, 30, -20)
        view.fov = st.slider("Field of view", 60, 150, 100)

    st.markdown("### Settings")
    SPEEDS = {"Fast": (3, 512), "Standard": (5, 640), "Detailed": (5, 960)}  # (frames/s, detector px)
    c1, c2 = st.columns(2)
    speed = c1.selectbox("Speed", list(SPEEDS), index=1,
                         help="Fast = 3 frames/s - quick look, may miss people walking straight through. "
                              "Standard = 5 frames/s (recommended). Detailed = 5 frames/s with a larger detector input "
                              "for small or distant people. Black / blanked-off areas and still areas are always skipped.")
    sample_fps, imgsz = SPEEDS[speed]
    resident_min = c2.number_input("Operator min", 0.0, 120.0, 0.0, 0.5,
                                   help="Minutes in area to count as an operator, else through-traffic. 0 = auto")
    c1, c2 = st.columns(2)
    model = c1.selectbox("AI model", ["yolo11n.pt", "yolo11s.pt", "yolo11m.pt"],
                         help="n = fastest, s = better for small/overhead people, m = most accurate (GPU)")
    page = c2.selectbox("PDF size", ["A3", "A4"])
    backend = st.selectbox("Detector", ["yolo", "motion"],
                           help="yolo = AI person detection (use this). motion = no AI, can't tell people apart")
    with st.expander("Zones config (optional)"):
        cfg = st.file_uploader("Zones + calibration JSON", type=["json"],
                               help="Named zones -> minutes per zone + trips between zones")

video_path = None
if up is not None:
    video_path = os.path.join(WORK, up.name)
    if not os.path.exists(video_path) or os.path.getsize(video_path) != up.size:
        with open(video_path, "wb") as fh:
            fh.write(up.getbuffer())
elif local:
    if os.path.exists(local):
        video_path = local
    else:
        st.sidebar.error("File not found")

cfg_path = ""
if cfg is not None:
    cfg_path = os.path.join(WORK, "zones.json")
    with open(cfg_path, "wb") as fh:
        fh.write(cfg.getbuffer())

brand_header("Operator movement analysis", "Heat map and spaghetti diagram from factory camera footage")
if not video_path:
    st.info("Upload a clip or paste a file path in the sidebar to start.")
    st.stop()

circle = fisheye_circle(video_path, os.path.getmtime(video_path)) if camera == "fisheye" else None
src = VideoSource(video_path, camera, view, circle)


@st.cache_resource(show_spinner="Finding the picture area...")
def picture_area(path: str, mtime: float, cam: str, yaw: float, pitch: float, fov: float):
    m = valid_area(src)
    ys, xs = m.nonzero()
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else None
    return m, box


valid, valid_box = picture_area(video_path, os.path.getmtime(video_path), camera, view.yaw, view.pitch, view.fov)
duration = src.duration

# ================================================================ main: draw | segments + run
left, right = st.columns([3, 2], gap="medium")

with left:
    st.markdown("### 1. Draw areas on the frame")
    scrub = st.session_state.get("scrub", 0.0)
    frame = src.frame_at(scrub)
    if "shapes" not in st.session_state:
        st.session_state.shapes = []
    drawn = area_draw(frame, st.session_state.shapes, key=f"draw_{video_path}_{camera}", max_width=820,
                      crop=valid_box)
    if drawn is not None and drawn != st.session_state.shapes:
        st.session_state.shapes = drawn
    st.slider("Frame shown (seconds)", 0.0, max(duration - 0.1, 0.1), step=1.0, key="scrub")
    st.caption(f"{os.path.basename(video_path)} · {fmt_ts(duration)} · {src.fps:.0f} fps · "
               f"{src.size[0]}×{src.size[1]} · frame {fmt_ts(scrub)}")
src.close()

spec = shapes_to_spec(st.session_state.shapes)
roi = ROI.from_spec(spec, src.size, valid)

with right:
    st.markdown("### 2. Areas")
    n = {k: len(v) for k, v in spec.items()}
    st.caption(f"Include {n['include']} · Exclude {n['exclude']} · Doorways {n['entry']} · "
               f"analysing {roi.coverage if roi else 1:.0%} of the frame (black borders skipped)" +
               ("" if n["include"] else " (no include area = whole view)"))
    c1, c2 = st.columns(2)
    c1.download_button("Save areas", json.dumps(spec, indent=1), f"areas_{os.path.splitext(os.path.basename(video_path))[0]}.json",
                       "application/json", width="stretch", disabled=not st.session_state.shapes,
                       help="Save once per camera, load next time")
    with c2.popover("Load areas", width="stretch"):
        loaded = st.file_uploader("Areas JSON", type=["json"], label_visibility="collapsed", key="load_areas")
        if loaded is not None and st.button("Apply", key="apply_areas"):
            st.session_state.shapes = spec_to_shapes(json.load(loaded))
            st.rerun()

    st.markdown("### 3. Time segments")
    if "segs" not in st.session_state or st.session_state.get("segs_for") != video_path:
        st.session_state.segs = pd.DataFrame([{"start": "00:00:00", "end": fmt_ts(duration), "note": "whole clip"}])
        st.session_state.segs_for = video_path
    segs_df = st.data_editor(st.session_state.segs, num_rows="dynamic", width="stretch", hide_index=True,
                             column_config={"start": st.column_config.TextColumn("Start", width="small"),
                                            "end": st.column_config.TextColumn("End", width="small"),
                                            "note": st.column_config.TextColumn("Note")})
    seg_text = ", ".join(f"{r.start}-{r.end}" for r in segs_df.itertuples() if r.start and r.end)

    st.markdown("### 4. Run")
    base_mode = st.radio("PDF background", ["Empty floor", "Current frame"], horizontal=True,
                         help="Empty floor = operators removed (median of many frames)")
    crop_output = st.checkbox("Zoom PDF to analysed area", True)
    run_clicked = st.button("Run analysis", type="primary", width="stretch")
    bar = st.empty()


def options() -> Options:
    return Options(video=video_path, out_dir=os.path.join(WORK, "out"), title=title, camera=camera,
                   segments=seg_text, base_time=fmt_ts(scrub) if base_mode == "Current frame" else "",
                   backend=backend, model=model, sample_fps=sample_fps, imgsz=imgsz, config=cfg_path, page=page,
                   yaw=view.yaw, pitch=view.pitch, fov=view.fov, mount_height=mount_height, lens_fov=lens_fov,
                   resident_min_s=resident_min * 60, fisheye_circle=",".join(map(str, circle)) if circle else "",
                   roi=json.dumps(spec) if any(spec.values()) else "", crop_output=crop_output)


if run_clicked:
    import time
    prog = bar.progress(0.0, "Detecting and tracking...")
    t_start = time.time()

    def on_progress(p):
        el = time.time() - t_start
        eta = f" · about {fmt_ts(el / p - el)} left" if p > 0.03 else ""
        prog.progress(p, f"Detecting and tracking... {p:.0%}{eta}")

    try:
        st.session_state.tracks = track(options(), on_progress)
        st.session_state.run_s = time.time() - t_start
        st.session_state.labels = {}
    except Exception as e:  # surface parse / video errors to the user
        st.error(str(e))
        st.stop()
    bar.empty()

# ================================================================ results
if "tracks" in st.session_state:
    tr = st.session_state.tracks
    labels = st.session_state.get("labels", {})
    if "show_next" in st.session_state:  # renamed people: carry the filter over before the widget is built
        st.session_state.show = st.session_state.pop("show_next")
    show = st.session_state.get("show", [])
    out = report(options(), tr, labels, people=show or None)
    an = out["analysis"]
    people = out["people"]

    st.divider()
    st.markdown("### 5. Results")
    m1, m2, m3, m4, m5 = st.columns([1, 1, 1, 1, 1.4])
    m1.metric("Crew on floor (typical / peak)", f"{an.crew['median']:.0f} / {an.crew['max']:.0f}")
    m2.metric("Through-traffic passes", f"{an.through['passes']:.0f}", f"{an.through['per_hour']:.0f} per hour",
              delta_color="off")
    m3.metric("Metres walked (shown people)" if an.distance_m else "People shown",
              f"{sum(an.distance_m.values()):,.0f} m" if an.distance_m else str(len(an.paths)))
    m4.metric("Analysis time", fmt_ts(st.session_state.get("run_s", 0)))
    with m5:
        with open(out["pdf"], "rb") as fh:
            st.download_button("Download PDF" + (f" - {', '.join(show)}" if show else ""), fh.read(),
                               os.path.basename(out["pdf"]), "application/pdf", width="stretch")
        c1, c2 = st.columns(2)
        with open(out["csv"], "rb") as fh:
            c1.download_button("Tracks CSV", fh.read(), os.path.basename(out["csv"]), "text/csv", width="stretch")
        with open(out["headcount_csv"], "rb") as fh:
            c2.download_button("Headcount CSV", fh.read(), os.path.basename(out["headcount_csv"]), "text/csv",
                               width="stretch")

    res_l, res_r = st.columns([3, 2], gap="medium")
    with res_l:
        st.session_state.show = [n for n in st.session_state.get("show", []) if n in people]
        st.multiselect("Show people (blank = everyone) - screen and PDF follow this", people, key="show",
                       placeholder="Everyone")
        keys = [k for k in ("spaghetti", "combined", "operators", "through", "heatmap") if k in out]
        names = {"combined": "Heat + paths", "operators": "Operators", "through": "Through-traffic",
                 "heatmap": "Heat map", "spaghetti": "Spaghetti"}
        for tab, key in zip(st.tabs([names[k] for k in keys]), keys):
            tab.image(out[key], width="stretch")

    with res_r:
        st.markdown("### 6. People - name, merge, export")
        st.caption("Type a name (e.g. Josh). Same name on two cards = one person. A team name groups people "
                   "('Warehouse', 'Manager'). 'ignore' drops them. Then Apply names.")
        by_person: dict[str, list[dict]] = {}
        for r in out["tracklets"]:
            if r["operator"]:
                by_person.setdefault(r["operator"], []).append(r)
        all_roles = out["roles"]
        order = sorted(by_person, key=lambda n: (all_roles.get(n, "operator") == "through",
                                                 -sum(r["seen_s"] for r in by_person[n])))
        new_names = {}
        with st.container(height=470):
            per_row = 3
            for i in range(0, len(order), per_row):
                cols = st.columns(per_row)
                for col, name in zip(cols, order[i:i + per_row]):
                    rows = by_person[name]
                    best = max((r for r in rows if r["track"] in tr.thumbs), key=lambda r: r["seen_s"], default=None)
                    if best is not None:
                        col.image(cv2.cvtColor(tr.thumbs[best["track"]], cv2.COLOR_BGR2RGB), width=80)
                    role = "Through" if all_roles.get(name) == "through" else "Operator"
                    col.caption(f"{role} · {sum(r['seen_s'] for r in rows) / 60:.1f} min · {len(rows)} track(s)")
                    new_names[name] = col.text_input("Name", name, key=f"person_{name}",
                                                     label_visibility="collapsed").strip()
        with st.expander("Fix individual tracks (split a wrong merge)"):
            track_edits = {}
            rows = [r for r in out["tracklets"] if r["track"] in tr.thumbs and r["seen_s"] >= 1.0]
            for i in range(0, len(rows), 5):
                cols = st.columns(5)
                for col, r in zip(cols, rows[i:i + 5]):
                    col.image(cv2.cvtColor(tr.thumbs[r["track"]], cv2.COLOR_BGR2RGB), width=60,
                              caption=f"#{r['track']} {fmt_ts(r['start_s'])}")
                    track_edits[r["track"]] = col.text_input("Name", r["operator"], key=f"trk_{r['track']}",
                                                             label_visibility="collapsed").strip()
        if st.button("Apply names", type="secondary", width="stretch"):
            new_labels = dict(labels)
            for name, rows in by_person.items():
                if new_names.get(name) and new_names[name] != name:
                    for r in rows:
                        new_labels[r["track"]] = new_names[name]
            for tid, name in track_edits.items():
                if name and name != next((r["operator"] for r in out["tracklets"] if r["track"] == tid), name):
                    new_labels[tid] = name
            st.session_state.labels = new_labels
            st.session_state.show_next = [new_names.get(n, n) for n in st.session_state.get("show", [])]
            st.rerun()
