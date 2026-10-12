# Poka-yoke station → Ops Hub (Operations Hub V2)

Every check sends stamps to Ops Hub against the work/sales order, so the order shows it was kitted and checked.

## What already exists in Ops Hub (checked 12/10/2026)

| Item | Detail |
|---|---|
| Orders | `production_orders.order_number` holds `W270530`, `S99289`... (401 W, 314 S). `order_type` = `work_order` / `sales_order`. Same format the station scans. |
| Backend pattern | Writes go through backend (edge) functions; secrets server-side (see `AGENTS.md`, e.g. `cnc-job-request`, `service-issues`). |
| Box | `box-upload-worker` + `box_upload_jobs` queue already archives QC files into one Box folder per order (`S96934 - VIN 123456/`). |
| Secondary QC | `secondary_qc_findings`, `qc_closeout_log` exist for MES QC. |

## Stamps the station sends

One `POST` (multipart) per event to the Ops Hub function. Field `record` = JSON; field `image` = annotated JPG (completed event only).

| `event` | When | Key fields |
|---|---|---|
| `started` | Verify begins (order + model scanned) - logs the order first | `session_id`, `order_ref`, `order_type`, `board_id`, `operator`, `started` |
| `completed` | Camera result saved (auto-confirm or CONFIRM) | + `vision_result` PASS/FAIL/NO_RESULT, `result`, `inspection.components[]` (label, part no., expected, found, status), `finished`, image |
| `qc_confirmed` | Secondary QC physically confirmed a failed board | `result: QC_CONFIRMED`, `qc.by`, `qc.note`, `qc.at`, `qc.statement` |

All three share one `session_id`. `record_id` is unique per event, so retries are safe (upsert). Offline? The station queues and retries every 60 s.

Example `completed` record:
```json
{
  "event": "completed", "record_id": "W234566_DEMO-HILUX-01_20261012-045906", "session_id": "a8a44ffb...",
  "station": "PY-STATION-1", "order_ref": "W234566", "order_type": "WORK_ORDER", "board_id": "DEMO-HILUX-01",
  "operator": "JM", "started": "2026-10-12T04:59:05", "finished": "2026-10-12T04:59:06",
  "vision_result": "FAIL", "result": "FAIL", "qc": null,
  "inspection": {"match_score": 0.98, "passed": false, "components": [
    {"label": "M8 x 25 flange bolt", "part_number": "FAST-M8-25", "expected": 6, "found": 4, "status": "SHORT",
     "message": "Need 2 more M8 x 25 flange bolt (FAST-M8-25)  (4/6)"}]}
}
```

## Step 1 - Ops Hub side (paste into Lovable chat for Operations Hub V2)

> Add a Poka-Yoke integration so our overhead camera kitting station can stamp work/sales orders.
>
> 1. New table `pokayoke_inspections`: id uuid pk, record_id text unique not null, session_id text, event text ('started' | 'completed' | 'qc_confirmed'), order_number text not null, order_type text ('work_order' | 'sales_order', lower-cased from the payload), production_order_id uuid null references production_orders(id), station text, board_id text, operator text, vision_result text, final_result text, qc_by text, qc_note text, qc_at timestamptz, problems jsonb (components with status <> 'OK'), payload jsonb (full record), image_path text, started_at timestamptz, finished_at timestamptz, received_at timestamptz default now(). Index on (order_number, received_at desc). RLS: authenticated users can read; only the service role writes.
> 2. New private storage bucket `pokayoke-images`.
> 3. New backend function `pokayoke-ingest` with JWT verification OFF (the station is not a signed-in user). It must:
>    - reject unless header `x-pokayoke-key` equals secret `POKAYOKE_INGEST_KEY` (request the secret via the secure form);
>    - accept `multipart/form-data` with field `record` (JSON file) and optional field `image` (JPG);
>    - upsert into `pokayoke_inspections` on `record_id` (station retries must not duplicate);
>    - match `production_orders` on `upper(order_number)` and set `production_order_id` when found (keep the row even if no match);
>    - store the image at `pokayoke-images/<order_number>/<record_id>.jpg` and save `image_path`;
>    - return `{ok: true, production_order_id}`; 401 on a bad key, 400 on bad payload.
>    - Do NOT change `production_orders.status` (NetSuite/MES own that).
> 4. UI: on the MES Orders tab and Work Order Lookup, show a "Poka-yoke" chip per order from the latest `pokayoke_inspections` row: Started (grey), PASS (green), FAIL (red), QC confirmed (white, with QC initials). Clicking opens the image, missing items list, operator, station and times.
> 5. Box: when an event is `completed` or `qc_confirmed`, enqueue a `box_upload_jobs` row so the existing `box-upload-worker` copies the JPG + record JSON into that order's Box folder.
> 6. Add a short note to AGENTS.md: poka-yoke stamps arrive only through `pokayoke-ingest`, keyed on `record_id`.
>
> When done, tell me the full function URL.

## Step 2 - Station side

`settings.json`:
```json
"export": {
  "webhook": {
    "enabled": true,
    "url": "https://<your-project>.supabase.co/functions/v1/pokayoke-ingest",
    "token_header": "x-pokayoke-key",
    "send_started": true,
    "send_image": true
  },
  "box": {"enabled": false}
}
```
`secrets.json` (git-ignored) - same value you enter in Lovable's secret form:
```json
{"export": {"webhook": {"token": "<long random key>"}}}
```
Make a key: PowerShell `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")`.

- Keep station `box.enabled: false` once Ops Hub step 5 is live, so Box gets one copy via Ops Hub's existing worker, not two.
- Check delivery: `/log` "Export" column shows `sent: webhook` or `retrying (...)`.

## Step 3 - Test

1. Scan a real order (e.g. one from Ops Hub's Orders list) → model → verify.
2. Ops Hub Orders tab: chip shows **Started**, then **PASS** / **FAIL** within a few seconds.
3. Fail one on purpose → Secondary QC confirm → chip shows **QC confirmed (AB)**.
4. Unplug network, run a check, reconnect → it arrives within 60 s.
