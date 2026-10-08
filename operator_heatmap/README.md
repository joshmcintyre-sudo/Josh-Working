# Operator Heat Map + Spaghetti Diagram

Factory camera footage (fixed or 360) → PDF with a base photo of the area, a dwell **heat map** and a **spaghetti diagram** of operator walking paths, plus a data page.

## Install (Windows / Mac / Linux, Python 3.10+)
```bash
cd operator_heatmap
pip install -r requirements.txt
```
GPU optional. CPU with `yolo11n.pt` @ 5 fps ≈ real-time-ish for 1080p (10 min clip ≈ 5–15 min).

## Use – web app (upload → chop → analyse → PDF)
```bash
streamlit run app.py          # opens http://localhost:8501
```
1. Upload clip (up to 8 GB) or paste a path on a network share
2. Camera: `fixed` or `360` → for 360, slide yaw/pitch/FOV until the work area fills the preview
3. Segments table: add rows `00:05:00 → 00:20:00`, `01:10:00 → 01:25:00` (skip breaks, changeovers)
4. Background: **Empty floor** (median frame, operators removed) or the frame you scrubbed to
5. Run → **Download PDF** (+ raw CSV)

## Use – command line (batch / scheduled)
```bash
python heatmap_cli.py line3.mp4 --segments "00:05:00-00:20:00, 01:10:00-01:25:00" --title "Line 3 – Shift A"
python heatmap_cli.py cell.mp4 --camera 360 --yaw 90 --pitch -30 --fov 110
python heatmap_cli.py line3.mp4 --config examples/zones_example.json --page A3
```

## Output (`output/`)
| File | Content |
|---|---|
| `*_operator_heatmap.pdf` | p1 heat + spaghetti, p2 heat map, p3 colour-per-path spaghetti, p4 data tables |
| `*_combined/heatmap/spaghetti.png` | Same images for PowerPoint/A3 boards |
| `*_tracks.csv` | track_id, time, foot x/y – pivot in Excel/Power BI |

## Zones + metres (optional, `examples/zones_example.json`)
- `zones`: polygons (pixel coords of the analysed view) → **dwell min per zone** + **trips A→B** (arrows, thickness = trips)
- `calibration`: 4 image points ↔ 4 floor points in metres (pallet corners, floor-tape) → **metres walked**, m/hour. Or `{"px_per_m": 85}`
- Get pixel coords: open `*_combined.png` in Paint (bottom-left shows x,y) and hover

## How it works
- Detector: YOLO11 person class + ByteTrack IDs (`--backend yolo`) or background subtraction (`--backend motion`, no AI)
- Each person → foot point (bottom-centre of box) = where they stand on the floor
- Tracks < 2 s dropped, 3-sample smoothing, path broken at > 2 s gaps / teleports
- 360: equirectangular frame re-projected to a flat virtual camera before detection
- Heat = seconds spent per pixel, Gaussian spread, TURBO colour scale

## Tips
- Fixed camera high + looking down (≥ 3 m, 30–60° down) gives the cleanest foot points
- 360: mount at ceiling, centre lens over the cell; use `--pitch -60 … -90` for near-overhead view
- Use `yolo11s.pt`/`yolo11m.pt` if operators are small/occluded; raise `--sample-fps` for fast movement
- Privacy: only anonymous track IDs are stored – no faces/identities. Check site policy / union agreement (AU: Workplace Surveillance Act 2005 NSW, Surveillance Devices Act 1999 VIC; NZ Privacy Act 2020; CA PIPEDA) before using footage for time-and-motion.
