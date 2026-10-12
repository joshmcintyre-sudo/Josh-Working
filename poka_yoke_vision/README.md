# Poka-Yoke Board Vision Station

Local vision check for model-specific poka-yoke kitting boards. Scan the work/sales order → scan the model → camera checks the board → PASS, FAIL or secondary-QC confirmation → logged against the order, with JSON + image queued for your app and Box.

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
python -m pytest -q tests                                      # 30 tests: vision, learn→verify, orders, QC, log, export/Ops Hub stamps, camera barcode scanning: pass/missing/short/moved/lighting/wrong board/API
```

## Operator workflow (`/`) - scan order first

| # | Screen | Operator does | System does |
|---|---|---|---|
| 1 | **Scan order** (idle) | Scan work/sales order barcode (`W234566`, `S98993`) + initials | Validates format, sets type (W = work order, S = sales order). Camera off |
| 2 | **Load model type** | Scan model barcode (or pick from list) | Shows the order and any earlier checks on it. Taught → **VERIFY BOARD**. New → **LEARN MODE** |
| 3 | **Learn mode** (prompted) | a) EMPTY board → CAPTURE<br>b) "Load PART 1" → CAPTURE → bronze box appears on the new part → name, part no., qty → SAVE PART<br>c) repeat → **ALL PARTS LOADED**<br>d) "Reference 2 of 3: lift and re-place parts" → CAPTURE<br>e) **SAVE BOARD** | Finds each new part automatically, learns sizes for counted parts |
| 4 | **Verify** | Load the finished board | Live check; auto-confirms after PASS holds `auto_stop_pass_seconds` (or CONFIRM) |
| 5a | **PASS** | – | Green border + **"Now ready to bag and package kit"** |
| 5b | **FAIL / unable to confirm** | Fix items → **RE-CHECK BOARD**, or **SECONDARY QC CONFIRM** | Red border + **"Review despatch list and verify all items are present"** + what's missing / how many more |
| 5c | **QC CONFIRMED** | Second person physically checks, enters/scans QC initials + note | White border + "Physically confirmed by secondary QC (AB) - Now ready to bag and package kit". Camera result kept as FAIL; final result `QC_CONFIRMED` |

- **Secondary QC rule:** QC initials must differ from the operator (`qc_must_differ`). Only offered when the camera did not pass the board.
- **Barcode scanning:** any USB keyboard-wedge scanner (e.g. Zebra DS2208, Honeywell Voyager 1250g). Fields auto-focus; the scanner's Enter advances. Symbology prefixes (e.g. `]C1W234566`) are stripped. Order format is set by `order_types` / `order_pattern`.
- Model barcode scanned in learn mode is remembered against the board.
- Learn tips: hands out of view on each CAPTURE; one fastener type at a time with its qty (qty > 1 = counted); **Wrong area - retry**; **Undo last part**.

## Camera as barcode scanner

The overhead camera reads barcodes too, so a hand scanner is optional.
- **Order screen:** camera scanning starts automatically. Hold the despatch paperwork / order label under the camera → reads `W234566` / `S98993` → beeps → moves to the model step. Only valid order codes are accepted here.
- **Model screen:** reads the model barcode on the board or kit label → loads the board. Order codes are ignored here.
- **Secondary QC:** QC can hold their badge barcode under the camera to fill QC initials.
- **Board label check** (`qr_autoselect: true`): during verify, any barcode/QR on the board that belongs to a different board flags **WRONG BOARD**; with no board selected it auto-selects.
- Reads Code 128, Code 39, QR, DataMatrix, EAN/UPC (via `zxing-cpp`; without it, QR only). Small labels are retried at 2x.
- Same code is ignored for 3 s so one label can't trigger twice. **Stop camera** / **Scan with camera** toggles it per screen.
- Settings: `camera_scan` (show it), `camera_scan_auto` (start automatically), `scan_fps` (default 5).
- **Label size (the main limit):** the camera sees the whole board, so each pixel covers roughly *board width ÷ image width* (1200 mm ÷ 1280 px ≈ 0.9 mm; at 1920 px ≈ 0.6 mm). Decoders need ~2 px per narrow bar / QR cell.
  - Flat on the board: use **QR codes ≥ 50 mm** (or ≥ 35 mm at 1920x1080). A 7-character Code 128 lying on the board would need to be ~250 mm wide.
  - Paperwork / order labels: **hold the sheet up toward the camera** (half the distance = double the resolution). A standard 60–80 mm Code 128 order label reads when held ~30–40 cm below a camera mounted 1 m up. Adding a QR code of the order number to the despatch printout makes this easier.
  - Matte label stock (gloss glares); keep labels flat and square to the camera. A hand scanner stays the fastest option for small 1D labels.

## Order log (`/log`)

Every check is one row in `results/order_log.db` (SQLite): time, order, type, model, operator, camera result, final result, QC by/time/note, issues, image thumbnail, export status. Search by scanning an order barcode; filter by result; **Download CSV** (`results/inspections.csv` is the append-only audit trail - a QC confirmation adds a second row).

## Sending results to another app and Box

Each saved record is queued in `results/outbox/pending/` and sent in the background; network drops retry every `retry_seconds`, sent jobs move to `outbox/sent/`. Status shows in the order log. Both targets are off until configured.

**Your app (webhook)** - `POST` multipart: `record` (JSON) + `image` (JPG). Three events per check, linked by `session_id`: `started` (order logged when verify begins), `completed` (camera result + image), `qc_confirmed` (secondary QC). Auth: `token` sent as `Authorization: Bearer`, or in a custom header via `token_header` (e.g. `x-pokayoke-key`). **Ops Hub setup: see [OPS_HUB_INTEGRATION.md](OPS_HUB_INTEGRATION.md).**
```json
"export": { "webhook": { "enabled": true, "url": "https://your-app/api/pokayoke/results" } }
```

**Box (upload to folder API)** - `POST https://upload.box.com/api/2.0/files/content` with the record JSON + annotated JPG into one folder. Files are named `<order>_<model>_<yyyymmdd-hhmmss>.json/.jpg`; a QC confirmation uploads an extra `..._QC.json`.
1. Box Developer Console → Create Platform App → Custom App → **Server Authentication (Client Credentials Grant)**. Scope: *Write all files and folders*. Submit for admin authorisation (Box Admin Console → Apps → Platform Apps Manager).
2. Create/choose the results folder, e.g. `Operations > Poka-Yoke Results`; folder ID is the number in its URL. Invite the app's service account (`AutomationUser_...@boxdevedition.com`) as Editor.
3. `settings.json` → `"box": {"enabled": true, "folder_id": "<id>"}`. Copy `secrets.example.json` to `secrets.json` (git-ignored) and fill `client_id`, `client_secret`, `subject_id` (enterprise ID). For a quick test a 60-min `developer_token` works instead.

Ref: Box docs - [Upload file](https://developer.box.com/reference/post-files-content/), [Client Credentials Grant](https://developer.box.com/guides/authentication/client-credentials/).

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

`results/YYYY-MM-DD/<order>_<board>_<yyyymmdd-hhmmss>.json` + annotated `.jpg`, plus one row per run in `results/inspections.csv` (opens in Excel / Power BI).

```json
{
  "station": "PY-STATION-1", "board_id": "DEMO-HILUX-01", "record_id": "W234566_DEMO-HILUX-01_20261012-045906", "order_ref": "W234566", "order_type": "WORK_ORDER", "operator": "JM",
  "started": "2026-10-12T04:59:05", "finished": "2026-10-12T04:59:06", "vision_result": "FAIL", "result": "FAIL", "qc": null, "operator_prompt": "Review despatch list and verify all items are present",
  "inspection": { "match_score": 0.982, "passed": false, "message": "FAIL - 2 item(s) to fix",
    "components": [
      {"label": "Door seal 450mm", "part_number": "SEAL-EPDM-450", "expected": 1, "found": 0, "status": "MISSING",
       "message": "MISSING 1 x Door seal 450mm (SEAL-EPDM-450)"},
      {"label": "M8 x 25 flange bolt", "part_number": "FAST-M8-25", "expected": 6, "found": 4, "status": "SHORT",
       "message": "Need 2 more M8 x 25 flange bolt (FAST-M8-25)  (4/6)"} ] },
  "image": "W234566_DEMO-HILUX-01_20261012-045906.jpg"
}
```
Point `results_dir` in `settings.json` at a network share / OneDrive / Box Drive folder to collect results centrally (e.g. pick up with Power Automate or a NetSuite CSV import keyed on `order_ref`).

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
| `qr_autoselect` | false | `true` = read a barcode/QR label on the board (Board ID or a learned model barcode); auto-selects board and flags mismatch |
| `results_dir` | results | can be a network share; in JSON escape backslashes: `"\\\\server\\share\\py-results"` |
| `order_types` / `order_pattern` | W, S / `^[A-Z]\\d{4,10}$` | order prefixes and format |
| `qc_must_differ` | true | QC person must differ from operator |
| `export` | off | webhook + Box, see above |
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

## Branding

Screens follow Utemaster brand guidelines: Rich Black / White, Bronze for the one primary action and step labels, Aptos Narrow uppercase headings (Beachwood if installed), Aptos body (Neue Montreal if installed), 2 px corners, Black 60 precision lines.
- **Logo:** put the official `Utemaster_Wordmark_Primary_White.svg` in `static/brand/` (Box path in `static/brand/README.txt`). Until then a `[UTEMASTER LOGO]` placeholder shows. Do not redraw it.
- **Exception:** PASS green / FAIL red are kept only on the result banner and screen border as functional safety signals (standard andon practice). QC-confirmed uses brand White.
