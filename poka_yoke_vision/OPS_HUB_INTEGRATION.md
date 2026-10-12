# Poka-yoke station ↔ Ops Hub (Operations Hub V2)

Ops Hub launches the station from an MES checklist step. The result comes back into that step, and the photo is archived through Ops Hub's existing Box link. The station does not upload to Box itself.

```text
Ops Hub MES checklist (browser, logged in)          Station PC (this app, http://127.0.0.1:8080)
 ─ step "Poka-yoke board check"
 ─ [Launch Poka-Yoke check] ──creates pokayoke_launches row (launch_id)
        └─ opens /launch?launch_id&order&model&operator&return ─▶ skips order/model scan, verifies board
                                                                 ├─ PASS ─▶ "Now ready to bag and package kit"
                                                                 └─ FAIL ─▶ fix / re-check / secondary QC confirm
 ◀── pokayoke-ingest (edge function) ◀── started / completed / qc_confirmed + photo (queued, retried)
 ─ step result written to qc_check_results (passed, value, notes, photo)
 ─ box_upload_jobs → existing box-upload-worker → order's Box folder
 ◀── [Return to Ops Hub] closes the station tab
```

## What Ops Hub already has (checked 12/10/2026)

| Item | Detail |
|---|---|
| Orders | `production_orders.order_number` = `W270530`, `S99289`...; `assembly_item` (from NetSuite) = the model, which is passed to the station |
| Checklist steps | `qc_check_items.check_type`: `pass_fail` (249), `photo` (75), `yes_no` (40), `data_entry` (24), `multi_photo` (1). Built in `src/components/mes/ChecklistsTab.tsx` |
| Step results | `qc_check_results` (order_id, checklist_id, check_item_id, item_number, passed, value, notes, photo_path, checked_by, checked_at) |
| Box | `box-upload-worker` + `box_upload_jobs` already archive QC files per order |
| Station address | `integration_connections` table (provider / base_url) |

## Station side (done)

- `GET /launch?launch_id=&order=&model=&operator=&checklist=&step=&return=` opens the operator screen and goes straight to verify when the model is taught (else learn mode, model pre-filled).
- `return` is only honoured for origins in `ops_hub_origins` (default `https://*.lovable.app`; add your custom domain).
- `GET /api/ping` answers Ops Hub with CORS and Private Network Access headers, so Ops Hub can check the app is running.
- `pokayoke://launch?...` links start the app if it isn't running (`install_windows.bat` registers this and starts the app at login).
- Every record carries `launch_id` and `launch` {checklist, step, model, source}. Events: `started`, `completed`, `qc_confirmed` (a re-check sends another `completed`; latest wins).
- **Return to Ops Hub** button on the result screen.
- Optional `&variants=<part label or id>:<black|white|steel>` (comma-separated) on the launch link makes a colour variant mandatory for that order, e.g. `variants=Mounting bracket LH:white` when the order is for the white bracket. Without it, any allowed variant passes and the record says which (`variant`). Ops Hub can fill this later from the NetSuite order/assembly item.

Station settings (now set in `settings.json`; Ops Hub build commit `7a60d1ac`, 12/10/2026):
```json
"ops_hub_origins": ["https://opshub.utemaster.com", "https://umopshub.lovable.app", "https://*.lovable.app"],
"export": {
  "webhook": {"enabled": true, "url": "https://bhviwenfznilluoxftva.supabase.co/functions/v1/pokayoke-ingest",
              "token_header": "x-pokayoke-key", "send_started": true, "send_image": true},
  "box": {"enabled": false}
}
```
No key is needed for launched checks: the one-time `launch_id` authenticates them. A key (`POKAYOKE_INGEST_KEY` in Ops Hub, `token` in `secrets.json`) is only needed for checks started on the station itself.

## Ops Hub build (sent to Lovable)

The prompt sent to the Operations Hub V2 project is in the session history and summarised here:
1. New step type **Poka-yoke Board Check** (`check_type = 'pokayoke'`) in the checklist builder, with an optional model override per step.
2. `pokayoke_launches` (one row per button press; its id is the `launch_id`) and `pokayoke_inspections` (every station event).
3. QC execution: **Launch Poka-Yoke check** button → ping station → open `/launch` (or `pokayoke://` if it's not running) → live status → step passes on PASS / QC confirmed. Operators can't tick it manually.
4. `pokayoke-ingest` edge function: validates `launch_id` (or the key), stores the event and photo, writes `qc_check_results`, queues Box upload through the existing worker.
5. Integrations card: station URL and recent checks.

## Test plan

Full step-by-step verification with SQL checks and sign-off: [OPS_HUB_VERIFICATION.md](OPS_HUB_VERIFICATION.md). Quick version:

1. Station PC: run `install_windows.bat`, teach one board whose Board ID or learned barcode = the order's assembly item.
2. Ops Hub: add a Poka-yoke step to a test checklist (e.g. on order `TEST123`) → **Launch** → station opens on the verify screen.
3. PASS → Return to Ops Hub → step shows PASS with photo; Box folder for the order gets the JPG.
4. Remove a part → FAIL → step stays open with "Need 2 more ..." → Secondary QC confirm → step passes as QC confirmed.
5. Close the station app → Launch again → `pokayoke://` starts it.
