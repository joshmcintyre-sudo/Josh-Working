# Operator Heat Map + Spaghetti Diagram

Factory camera footage (fixed, 360 ceiling fisheye, or 360 panorama) with **multiple operators** → PDF with a base photo of the area, a dwell **heat map** and a **spaghetti diagram** of operator walking paths, plus a data page.

## Quick start (Windows)
1. Download: https://github.com/joshmcintyre-sudo/Josh-Working/archive/refs/heads/ccr-6f07bd32-8ig2xl.zip → unzip
2. Install Python from https://www.python.org/downloads/ (install manager: answer y, reboot), then in cmd: `py install 3.12`
3. Open `operator_heatmap` → double-click **`run_windows.bat`** (first run installs, ~5–10 min) → browser opens at http://localhost:8501
Mac/Linux: `./run_mac_linux.sh`

## Install manually (Windows / Mac / Linux, Python 3.10+)
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
2. Camera:
   - **Fixed camera**
   - **360 ceiling fisheye** – round image looking down (Hikvision/Axis/Uniview/Dahua fisheye). Enter mount height → metres walked with no floor targets
   - **360 panorama** (Insta360, GoPro Max) → slide yaw/pitch/FOV until the work area fills the preview
3. **Area to analyse** – include/exclude rectangles (% of image) or fisheye pie slices; live preview dims what is ignored
4. Segments table: add rows `00:05:00 → 00:20:00`, `01:10:00 → 01:25:00` (skip breaks, changeovers)
5. Background: **Empty floor** (median frame, operators removed) or the frame you scrubbed to
6. No headcount needed – crew size is **measured** from the footage. Optional: min. minutes in area to count as an operator (auto = 1.5 min or 40 % of analysed time)
7. Run → **Download PDF** (+ track CSV, headcount CSV)
8. **Check / name people** – snapshot + auto role per track; same name = merge, a team name ("Warehouse", "Manager") groups them, `ignore` drops (forklift) → Rebuild PDF in seconds, no video re-processing

## Use – command line (batch / scheduled)
```bash
python heatmap_cli.py line3.mp4 --segments "00:05:00-00:20:00, 01:10:00-01:25:00" --title "Line 3 – Shift A"
python heatmap_cli.py roof360.mp4 --camera fisheye --mount-height 7.5 --operators 6
python heatmap_cli.py roof360.mp4 --camera fisheye --roi '{"include":[{"sector":[100,240,30,95]}]}'   # one bay only
python heatmap_cli.py cell.mp4 --camera 360 --yaw 90 --pitch -30 --fov 110
python heatmap_cli.py line3.mp4 --config examples/zones_example.json --page A3
```

## Output (`output/`)
| File | Content |
|---|---|
| `*_operator_heatmap.pdf` | Everyone · **Operators only** · **Through-traffic only** · heat map · spaghetti (operators colour, through-traffic grey) · one page per main operator · data page (crew size, passes/h, person table, headcount chart, zones, trips) |
| `*_combined/heatmap/spaghetti.png` | Same images for PowerPoint/A3 boards |
| `*_tracks.csv` | person, role (operator / through), track_id, time, foot x/y – pivot in Excel/Power BI |
| `*_headcount.csv` | people visible per sampled frame – staffing / congestion |

## Zones + metres (optional, `examples/zones_example.json`)
- `zones`: polygons (pixel coords of the analysed view) → **dwell min per zone** + **trips A→B** (arrows, thickness = trips)
- `calibration`: 4 image points ↔ 4 floor points in metres (pallet corners, floor-tape) → **metres walked**, m/hour. Or `{"px_per_m": 85}`
- Get pixel coords: open `*_combined.png` in Paint (bottom-left shows x,y) and hover

## Area isolation (speed + accuracy)
- `include` = only analyse here; `exclude` = always ignore (office glass, TV screens, walkway outside the cell, mezzanine)
- `entry` = doorway / aisle inside the view where people walk in and out (helps through-traffic detection)
- Shapes: `rect` [left%, top%, right%, bottom%] · `sector` [from°, to°, inner%, outer%] (fisheye, 0° = 12 o'clock, clockwise) · `poly` [[x,y],…] px
- Can also live in the zones config as `"roi": {...}`
- Speed: fixed cams crop to the area before detection; fisheye skips tiles/rows outside it. Measured 30 s fisheye clip: 99 s full view → 60 s for a 140° slice
- PDF zooms to the area (`--no-crop` to keep the full view)

## Multiple operators – how identities are kept
| Layer | What it fixes |
|---|---|
| BoT-SORT tracker + appearance ReID, 8 s lost-track memory | operators crossing, short occlusion |
| ID-swap splitter (sudden clothing-colour change inside a track) | tracker swaps two people at a crossing |
| Stitching (walkable gap + matching clothing colour, ≤ 15 s) | hidden behind racking/pillar, missed detections |
| **Operator vs through-traffic** (no headcount needed) | long time in area = operator; short visit that starts AND ends at the view edge / selection edge / `entry` zone = through-traffic (warehouse, other lines, managers); short track that starts or ends mid-floor = lost piece of an operator → rejoined |
| Re-entry | same-looking people never on screen together = one person who left and came back |
| Crew size measured | operators on screen at once: typical / 95 % / peak – no count to enter |
| Optional `--operators N` | if you ever do know the count, merges operators down to N |
| Manual names in the app | final say; merge / rename / ignore |

Tests (synthetic, real-person sprites, crossings + pillar, **no headcount given**):
- 4 operators: 40 raw IDs → 5 operators @ 96 % purity, crew measured typical 3 / peak 4, 0 through-traffic
- 3 operators + 6 walk-through passes: 73 raw IDs → role accuracy 97 %, 7 passes counted (truth 6), crew typical 2 / peak 3
Use the `yolo` detector for multi-operator work; `motion` cannot tell people apart (needs `--operators`).

## How it works
- Detector: YOLO11 person class + ByteTrack IDs (`--backend yolo`) or background subtraction (`--backend motion`, no AI)
- Each person → foot point (bottom-centre of box) = where they stand on the floor
- Tracks < 2 s dropped, 3-sample smoothing, path broken at > 2 s gaps / teleports
- Fisheye: circle auto-detected, unwrapped into 6 upright panorama tiles (overhead people point outward → upright after unwrap), detections mapped back to the circle; metres = mount height × tan(angle from nadir)
- 360 panorama: equirectangular frame re-projected to a flat virtual camera before detection
- Heat = seconds spent per pixel, Gaussian spread, TURBO colour scale

## Tips
- Fixed camera high + looking down (≥ 3 m, 30–60° down) gives the cleanest foot points
- Fisheye: best results within ~75 % of the radius; directly under the lens people are seen head-on from above and detect less reliably. Use `yolo11s.pt` if operators are small. Check lens FOV on the datasheet (`--lens-fov`, e.g. 180–187)
- Use `yolo11s.pt`/`yolo11m.pt` if operators are small/occluded; raise `--sample-fps` for fast movement
- Privacy: only anonymous track IDs are stored – no faces/identities. Check site policy / union agreement (AU: Workplace Surveillance Act 2005 NSW, Surveillance Devices Act 1999 VIC; NZ Privacy Act 2020; CA PIPEDA) before using footage for time-and-motion.
