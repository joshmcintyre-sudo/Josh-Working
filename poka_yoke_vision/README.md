# Poka-Yoke Board Vision Station

Local (offline) vision check for model-specific poka-yoke kitting boards. Overhead USB camera → teach a good board → operator presses **START**, screen shows what is missing / how many more are needed → **STOP & SAVE** writes a result file.

- Runs on a basic office PC (CPU only, 1–5 fps). No cloud, no GPU, no model training.
- Python + OpenCV + Flask. UI is a browser page on the station monitor.
- One folder per board in `boards/` → 20+ boards per product line is fine.

## Quick start (Windows)

1. Install Python 3.11+ from python.org (tick "Add to PATH").
2. Double-click `run_station.bat` (first run creates `.venv` and installs deps).
3. Browser opens at `http://127.0.0.1:8080/` → press **F11** for full screen.

Manual / Linux:
```bash
cd poka_yoke_vision
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m pokayoke.app                             # operator: /   engineer: /teach
```

Try it with no camera:
```bash
python -m pokayoke.demo                                        # builds DEMO-HILUX-01 board
python -m pokayoke.app --image demo_images/missing_parts.png   # -> FAIL: seal missing, need 2 more bolts
python -m pytest -q tests                                      # 11 tests incl. full learn→verify workflow;: pass/missing/short/moved/lighting/wrong board/API
```

## Operator workflow (`/`) - new despatch list

| # | Screen | Operator does | System does |
|---|---|---|---|
| 1 | **SYSTEM IDLE** | Press **NEW DESPATCH LIST** (or just scan the despatch barcode) | Camera off |
| 2 | **Despatch list** | Scan/type despatch list no. + initials | Stored on the result file |
| 3 | **Load model type** | Scan model barcode (or pick from list) | Finds the board. Taught → **VERIFY BOARD**. New/untaught → **LEARN MODE** |
| 4 | **Learn mode** (prompted) | a) Place EMPTY board → CAPTURE<br>b) "Load PART 1" → CAPTURE → orange box appears around the new part → type name, part no., qty → SAVE PART<br>c) repeat for each part → **ALL PARTS LOADED**<br>d) "Reference 2 of 3: lift and re-place parts" → CAPTURE (x `learn_repeats`)<br>e) **SAVE BOARD** | Finds each new part automatically (difference vs previous capture), learns sizes for counted parts |
| 5 | **Verify** | Load the finished board | Live check; auto-confirms after PASS holds `auto_stop_pass_seconds` (or press CONFIRM) |
| 6a | **PASS** | – | Green border + **"Now ready to bag and package kit"** |
| 6b | **FAIL** | Fix items → **RE-CHECK BOARD** | Red border + **"Review despatch list and verify all items are present"** + list of what's missing / how many more |

- **Barcode scanning:** any USB keyboard-wedge scanner (e.g. Zebra DS2208, Honeywell Voyager 1250g) works with no setup: fields auto-focus and the scanner's Enter advances the step. The model barcode you scan in learn mode is remembered against the board, so next time scanning it loads the board directly. Part-number field also accepts a part barcode scan.
- Learn tips: hands out of view on each CAPTURE; put all of one fastener type down in one go and enter the qty (qty > 1 = counted); wrong box? **Wrong area - retry**; mistake after saving? **Undo last part** and take it off the board.
- Prompts are editable in `settings.json` (`pass_message`, `fail_message`).

## Teaching / fine-tuning a board (engineer, `/teach`)

The operator learn mode above is the normal way to create a board. Use `/teach` to adjust boxes, thresholds or methods afterwards, or to build a board by hand:

1. **New board** → enter Board ID (match the ID on the physical board label, e.g. `PY-HILUX-DC-001`), description, product line.
2. Put the **bare board** under the camera → **1. Capture EMPTY board**. Needed for counting and gives the most reliable presence check.
3. Load the board **correctly** → **2. Capture GOOD board**. Repeat 2–3 times, moving parts slightly each time (bag position, seal curl) – more references = fewer false fails.
4. Drag a box around each part location → type the operator label (e.g. `M8 x 25 flange bolt`).
5. In the table set **Part #**, **Qty**, **Method**:

| Method | Use for | How it decides |
|---|---|---|
| `presence` | brackets, seal strips, loom bags, single items | Is this box closer to the *good* photo or the *empty* photo? Score 0–1, `Thr` 0.5 = halfway |
| `count` | loose fasteners, clips, washers sharing one pocket | Area of "not empty board" pixels ÷ learned area of one part → "Need 2 more" |

6. **Save & calibrate** (learns per-part size from the photos) → **Test current view** with parts removed to prove each box flags.

Tips: one box per pocket/shadow outline; keep boxes tight; one `count` box per fastener type; don't put two different parts in one box.

## Verify screen

- Green = OK, Amber = short/extra (`Need 2 more …` / `Remove 1 x …`), Red = missing.
- Result is a vote over the last `stable_frames` frames, so a hand passing over the board doesn't flip it.
- **WRONG BOARD** = the board in view doesn't match the selected board's taught background.

## Result files

`results/YYYY-MM-DD/<board>_<HHMMSS>_<despatch>.json` + annotated `.jpg`, plus one row per run in `results/inspections.csv` (opens in Excel / Power BI).

```json
{
  "station": "PY-STATION-1", "board_id": "DEMO-HILUX-01", "despatch_ref": "DL-5501", "operator": "JM",
  "started": "2026-10-12T04:59:05", "finished": "2026-10-12T04:59:06", "result": "FAIL", "operator_prompt": "Review despatch list and verify all items are present",
  "inspection": { "match_score": 0.982, "passed": false, "message": "FAIL - 2 item(s) to fix",
    "components": [
      {"label": "Door seal 450mm", "part_number": "SEAL-EPDM-450", "expected": 1, "found": 0, "status": "MISSING",
       "message": "MISSING 1 x Door seal 450mm (SEAL-EPDM-450)"},
      {"label": "M8 x 25 flange bolt", "part_number": "FAST-M8-25", "expected": 6, "found": 4, "status": "SHORT",
       "message": "Need 2 more M8 x 25 flange bolt (FAST-M8-25)  (4/6)"} ] },
  "image": "DEMO-HILUX-01_045906_DL-5501.jpg"
}
```
Point `results_dir` in `settings.json` at a network share / OneDrive / Box Drive folder to collect results centrally (e.g. pick up with Power Automate or a NetSuite CSV import keyed on `despatch_ref`).

## settings.json

| Key | Default | Notes |
|---|---|---|
| `camera_index` | 0 | 1, 2… if the PC has a built-in webcam |
| `width` / `height` | 1280 / 720 | 1920×1080 if small fasteners are < ~15 px across |
| `fps` | 2 | inspections per second; 1–3 is plenty |
| `stable_frames` | 3 | frames voted for the shown/saved result |
| `auto_stop_pass_seconds` | 2 | auto-confirm once PASS holds this long (0 = operator presses CONFIRM) |
| `learn_repeats` | 3 | full-board reference captures in learn mode (more = fewer false fails) |
| `pass_message` / `fail_message` | see file | operator prompts on the result screen |
| `qr_autoselect` | false | `true` = read a QR code on the board (text = Board ID); auto-selects board and flags mismatch |
| `results_dir` | results | can be a network share; in JSON escape backslashes: `"\\\\server\\share\\py-results"` |
| `host` | 127.0.0.1 | `0.0.0.0` to view from a supervisor's PC (LAN only) |

## Hardware (tested approach, typical AU/NA supply)

- **Camera:** 1080p USB with manual focus/exposure lock is ideal. Logitech C920/C922 or Brio (JB Hi-Fi / Officeworks AU, Best Buy / Amazon NA); ELP or Arducam USB board cameras with a varifocal lens for fixed mounts (Core Electronics AU – core-electronics.com.au, Amazon NA).
- **Mount:** directly overhead, square to the board, ~1–1.5 m for a 1200 × 800 board. A VESA pole/monitor arm or 25 mm aluminium extrusion works.
- **Lighting matters most:** 2 diffused LED panels either side (~45°) beats any camera upgrade. Block direct sun/windows. Shiny zinc/bags cause glare – diffuse it.
- **Board:** fixed locating stops on the bench help; the software also auto-aligns (shift/rotation tolerated). Matte, high-contrast shadow board (e.g. yellow/orange foam or painted MDF behind dark parts) gives the best results. Black EPDM seal on black foam = hard; use a contrasting colour pocket.
- **QR label** on each board (any free generator, text = Board ID) for guaranteed right-board check when boards look similar.

## How it works

1. **Align**: ORB features + RANSAC homography warp the live frame onto the reference ([OpenCV tutorial](https://docs.opencv.org/4.x/d1/de0/tutorial_py_feature_homography.html)).
2. **Right board?** Feature-match quality × correlation of the bare-board background outside the part boxes (`min_match_score`, default 0.5; same board ≈ 0.95+, different board ≈ 0.1 in tests).
3. **Lighting** normalised to the reference (global gain/offset).
4. **Per part**: `presence` = LAB colour + histogram distance to good vs empty; `count` = foreground area vs empty board ÷ unit area, plus blob count.
5. **Vote** over last N frames → screen + result file.

Code: `pokayoke/inspector.py` (vision), `station.py` (camera, start/stop, results), `app.py` (web/API), `board.py` (board files), `templates/` (screens).

## Limits / next steps

- Parts that look like the board behind them (same colour) → use contrasting pocket colours or add a reference with that part in several positions.
- Overlapping loose fasteners piled up undercount – keep a pocket per small batch.
- If you later need part-type recognition (e.g. M8 vs M10 bolt mixed in a pocket), add a YOLO model (Ultralytics) per `count` box; the result file and screens stay the same.
- Commercial comparables if you outgrow this: Keyence IV3 / Cognex In-Sight 2800 smart-camera AI sensors do the same presence/count check (quoted per station).
