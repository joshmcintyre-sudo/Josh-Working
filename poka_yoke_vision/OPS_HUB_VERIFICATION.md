# Ops Hub ↔ Poka-Yoke Station: Verification Plan

Run this before the station goes live. It checks the Ops Hub (Lovable) build, then the station-to-Ops Hub link, then real end-to-end checks. Tick each box, and record anything that fails in the sign-off table at the end.

| Item | Value |
|---|---|
| Ops Hub project | Operations Hub V2 (Lovable, project `e4eaab6e-4ae5-46f8-ab34-6c2c48434f6b`), build commit `7a60d1ac` |
| Ops Hub addresses | `https://opshub.utemaster.com`, `https://umopshub.lovable.app`, preview `https://id-preview--e4eaab6e-...lovable.app` |
| Ingest function | `https://bhviwenfznilluoxftva.supabase.co/functions/v1/pokayoke-ingest` |
| Station | `http://127.0.0.1:8080` on the shop-floor PC |
| Box folder | `QC Completions/<order>` (existing Box link) |

How to run the SQL below: ask the Lovable agent to run it ("run this SQL and show me the result"), or use Lovable's Cloud → Database view. All checks are **read-only** except section 3, which creates test rows on order `TEST123`.

---

## 1. Build is in place (Ops Hub / database)

### 1.1 Tables, column, bucket, policies
```sql
select
  (select count(*) from information_schema.tables where table_schema='public'
     and table_name in ('pokayoke_launches','pokayoke_inspections'))                       as tables_2,
  (select count(*) from information_schema.columns where table_name='qc_check_items'
     and column_name='pokayoke_model')                                                     as model_col_1,
  (select public from storage.buckets where id='pokayoke-images')                          as bucket_public_false,
  (select string_agg(policyname||' '||cmd, '; ') from pg_policies
     where tablename in ('pokayoke_launches','pokayoke_inspections'))                      as policies;
```
- [ ] `tables_2 = 2`, `model_col_1 = 1`, `bucket_public_false = false`
- [ ] Policies = `auth read inspections SELECT; auth read launches SELECT; own insert launches INSERT`. There must be **no** UPDATE or DELETE policy for signed-in users; only the backend function writes those.

### 1.2 Realtime is on for launches (the live status chip depends on it)
```sql
select tablename from pg_publication_tables
where pubname='supabase_realtime' and tablename='pokayoke_launches';
```
- [ ] Returns one row

### 1.3 Box worker knows the new record type
- [ ] In Lovable, open `supabase/functions/box-upload-worker`. It handles `record_type = 'pokayoke'` by uploading the record JSON + photo from `pokayoke-images`.

### 1.4 Secret for station-started checks (optional)
- [ ] `POKAYOKE_INGEST_KEY` is set in Lovable Cloud → Secrets (only needed for checks started on the station without the Ops Hub button). The same value goes in the station's `secrets.json` → `export.webhook.token`.

---

## 2. Ingest function rejects bad requests

Run from any PC with `curl` (Windows: use `curl.exe` in PowerShell). Save this as `record.json`:
```json
{"event":"completed","record_id":"VERIFY_TEST123_001","session_id":"verify-001",
 "order_ref":"TEST123","order_type":"WORK_ORDER","board_id":"DEMO-HILUX-01","station":"VERIFY",
 "operator":"QA","started":"2026-10-12T10:00:00+13:00","finished":"2026-10-12T10:00:10+13:00",
 "vision_result":"PASS","result":"PASS","qc":null,
 "inspection":{"board_ok":true,"passed":true,"message":"PASS - board complete","components":[]}}
```

| # | Command | Expect |
|---|---|---|
| 2.1 | `curl -s -X GET <ingest URL>` | `405` `POST only` |
| 2.2 | `curl -s -X POST <ingest URL> -F "x=1"` | `400` `Missing 'record' field` |
| 2.3 | `curl -s -X POST <ingest URL> -F "record=@record.json;type=application/json"` (no launch, no key) | `401` `Unauthorized` |
| 2.4 | Same as 2.3 + `-H "x-pokayoke-key: wrong"` | `401` |
| 2.5 | Edit `record.json` so `"event":"done"`, send with the correct key | `400` `event must be ...` |

- [ ] 2.1 – 2.5 as expected
- [ ] Nothing was written:
```sql
select count(*) from pokayoke_inspections where record_id like 'VERIFY_%';   -- expect 0
```

### 2.6 Key-authenticated write + duplicate handling (only if the key is set)
Send `record.json` (event `completed`) with `-H "x-pokayoke-key: <key>"` **twice**.
- [ ] Both return `{"ok":true,...}` with the **same** `inspection_id`
```sql
select count(*), max(order_number), max(final_result), max(production_order_id::text)
from pokayoke_inspections where record_id='VERIFY_TEST123_001';
-- expect 1 row, TEST123, PASS, production_order_id filled (TEST123 exists in production_orders)
```

---

## 3. Ops Hub screens

### 3.1 Checklist builder
1. MES → Checklists → pick (or create) a test checklist, e.g. "Poka-yoke Verify".
2. Add step → Step Type **Poka-yoke Board Check**, Required ticked, leave Model override blank.
- [ ] Step saves and shows the Poka-yoke icon and label
- [ ] The step is **not** offered as a trigger in "Only show this step based on a previous answer"
- [ ] Edit the step and set Model override = `DEMO-HILUX-01`; it saves
```sql
select title, check_type, required, pokayoke_model from qc_check_items where check_type='pokayoke';
```

### 3.2 Integrations card
- [ ] Production Tools → Integrations → **Poka-Yoke station** shows base URL `http://127.0.0.1:8080`
- [ ] On the station PC with the app running: **Test station on this PC** = OK. With the app closed = clear failure message.
- [ ] The first time, Chrome or Edge may ask to let Ops Hub "access devices on your local network". Choose **Allow**.

### 3.3 Checklist execution, before launch
Assign the checklist to order `TEST123` and open it in QC execution.
- [ ] The step shows **Launch Poka-Yoke check** and a status chip
- [ ] There is no tick box. An operator can't complete it by hand.
- [ ] A user with MES edit rights sees **Override (station unavailable)**, and it demands a reason
- [ ] The checklist can't be completed while this required step is open

---

## 4. End-to-end (station PC + Ops Hub)

Station prep: `install_windows.bat` has been run, and `settings.json` has the ingest URL, `export.webhook.enabled: true` and `ops_hub_origins` including `https://opshub.utemaster.com`. A board is taught whose Board ID (or learned model barcode) equals the order's assembly item, or the step's Model override.

After each scenario run the check query:
```sql
select l.id launch, l.status, l.vision_result, l.final_result, l.requested_by_name,
       i.event, i.final_result insp_result, i.qc_by, i.image_path is not null has_photo,
       r.passed step_passed, r.value step_value, r.notes, r.photo_path is not null step_photo,
       b.status box_status, b.last_error
from pokayoke_launches l
left join pokayoke_inspections i on i.launch_id = l.id
left join qc_check_results r on r.order_id = l.order_id and r.check_item_id = l.check_item_id
     and r.item_number = coalesce(l.item_number, 1)
left join box_upload_jobs b on b.record_type = 'pokayoke' and b.record_id = i.id
where l.order_number = 'TEST123'
order by l.created_at desc, i.received_at desc
limit 10;
```

| # | Scenario | Do | Expect in Ops Hub | Expect in DB |
|---|---|---|---|---|
| 4.1 | **PASS** | Launch → board complete | Station opens straight on verify for TEST123. Auto-confirms. **Return to Ops Hub** closes the tab. Chip = PASS, photo thumbnail shows | launch `completed`/PASS; events `started` + `completed`; step `passed=true`, value PASS, notes "Poka-yoke PASS", step_photo true; box job `done` |
| 4.2 | **FAIL → re-check** | Launch with 2 bolts missing → CONFIRM → add bolts → RE-CHECK | Chip FAIL with "Need 2 more M8 x 25 flange bolt", then PASS | 2 `completed` events; step ends `passed=true` (latest wins) |
| 4.3 | **FAIL → secondary QC** | Leave a part off → CONFIRM → Secondary QC confirm (different initials + note) | Chip **QC confirmed (initials)** | launch `qc_confirmed`; step `passed=true`, value QC_CONFIRMED, notes "Physically confirmed by secondary QC (AB): …" |
| 4.4 | **Same-person QC blocked** | In 4.3 type the operator's own initials | Station refuses | No `qc_confirmed` event |
| 4.5 | **Station closed** | Close the station app → Launch | `pokayoke://` starts it and the verify screen opens | As 4.1 |
| 4.6 | **Network drop** | Unplug network → run a check → reconnect | Chip updates within ~60 s of reconnect | Event arrives once (no duplicates) |
| 4.7 | **Bad light** | Cover the camera or switch the lights off during verify → CONFIRM | Station shows CHECK LIGHTING. Chip FAIL (NO_RESULT) | value NO_RESULT, step `passed=false` |
| 4.8 | **Wrong board** | Put a different board under the camera | Station shows WRONG BOARD | step `passed=false` |
| 4.9 | **Model not taught** | Override the step's model to an untaught ID → Launch | Station opens on the model step with "teach it once with LEARN MODE" | No result until taught |
| 4.10 | **Return link safety** | Open `http://127.0.0.1:8080/launch?order=TEST123&return=https://example.com` | No **Return to Ops Hub** button is offered | n/a |
| 4.11 | **Manual override** | MES editor → Override with a reason | Step completes | notes "Manual override: <reason>" |
| 4.12 | **Multi-qty order** | Checklist with Multiple Quantity WO, item 2 → Launch | Result lands on item 2 only | `item_number = 2` |

- [ ] 4.1 – 4.12 pass

### 4.13 Box
- [ ] In Box, `QC Completions/TEST123` holds the station photo + record JSON for 4.1 – 4.3. The QC JSON from 4.3 is there too.
- [ ] Generate the order's QC PDF in Ops Hub; the poka-yoke photo appears in it

### 4.14 Times are right
```sql
select record_id, started_at, finished_at, received_at from pokayoke_inspections
where order_number='TEST123' order by received_at desc limit 3;
```
- [ ] `finished_at` is within a minute of `received_at` (NZ time is stored correctly, not 12–13 h out)

### 4.15 Station side
- [ ] Station `/log` shows each check with Export = `sent: webhook`
- [ ] `results/outbox/pending` is empty after the network test

---

## 5. Clean up test data
Run only after sign-off. It deletes the TEST123 poka-yoke rows created above.
```sql
delete from pokayoke_inspections where order_number='TEST123';
delete from pokayoke_launches   where order_number='TEST123';
```
Remove the test checklist step from the "Poka-yoke Verify" checklist in the builder. That also deletes its step results.

---

## 6. Prompt to paste into Lovable (automated part of this check)

> Run a read-only verification of the Poka-yoke integration and report each item as PASS/FAIL with the evidence:
> 1. Tables `pokayoke_launches` and `pokayoke_inspections` exist; `qc_check_items.pokayoke_model` exists; bucket `pokayoke-images` is private.
> 2. RLS: signed-in users can only SELECT both tables and INSERT their own launches; no UPDATE/DELETE policies for them.
> 3. `pokayoke_launches` is in the `supabase_realtime` publication.
> 4. `pokayoke-ingest` is deployed with JWT verification off; POST with no body → 400; a valid record with no launch_id and no key → 401. Show the responses.
> 5. `box-upload-worker` handles `record_type = 'pokayoke'` (show the code path) and uploads into `QC Completions/<order>`.
> 6. `PokayokeStep` cannot be ticked manually; the override needs MES edit permission and a reason; a required pokayoke step blocks checklist completion.
> 7. Is the `POKAYOKE_INGEST_KEY` secret set? (yes/no only — never print it.)
> Do not change any code or data.

---

## Sign-off

| Section | Result | Checked by | Date | Notes |
|---|---|---|---|---|
| 1 Build in place | | | | |
| 2 Ingest rejects bad requests | | | | |
| 3 Ops Hub screens | | | | |
| 4 End-to-end | | | | |
| 5 Test data cleaned | | | | |

## If something fails

| Symptom | Likely cause | Fix |
|---|---|---|
| Launch does nothing, no prompt | Station not running and `pokayoke://` not registered | Run `install_windows.bat` on that PC |
| "Test station" fails but the app is running | Browser blocked local network access, or the page address isn't in `ops_hub_origins` | Allow local network access for Ops Hub; add the address to `settings.json` → restart the station |
| Station result never reaches Ops Hub | Wrong ingest URL, webhook disabled, or no network | Check `settings.json` → `export.webhook`; station `/log` Export column shows the error |
| `401` for launched checks | Launch older than 12 h, or the order on the station differs from the launch | Relaunch from the checklist |
| `401` for station-started checks | `POKAYOKE_INGEST_KEY` not set, or it differs from `secrets.json` | Set the same value in both |
| Step stays open after PASS | Result written to a different `item_number`, or realtime off | Run 1.2 and the section 4 query |
| No photo in Box | Box job error | `box_upload_jobs.last_error` for `record_type='pokayoke'`; Integrations → Box → Retry failed |
| Times 12–13 h out | Station running an old build without timezone stamps | Update the station to this version |
