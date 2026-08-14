# Loom Designer

A 12 V automotive DC wiring loom design tool. Draw a loom as a node/edge graph,
have every wire sized and every fuse chosen from published standards data, then
export a manufacturing drawing, cut list and BOM for hand-build in NZ or for
manufacture overseas.

## Commands

```bash
bun install
bun dev          # http://localhost:3000
bun test         # 258 tests
bun run typecheck
bun run build
```

Bun for everything. No `.env` is required — without Supabase credentials the app
falls back to browser-local storage and seeds itself with the demo loom.

## Stack

TanStack Start 1.168 · React 19.2 · Vite 8 · Tailwind 4 · vitest 4 · jspdf 4 ·
`@supabase/supabase-js` 2.

Two things that will bite if you change them:

- `src/router.tsx` **must** export `getRouter` (not `createRouter`) — this
  version of `@tanstack/start-client-core` imports that name.
- `@vitejs/plugin-react` 6 needs Vite 8. Downgrading Vite breaks the build with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` on `vite/internal`.

## Layout

```
data/                       reference data — the source of truth for all numbers
  wire.json                 conductors: area, resistance, mass, OD, ampacity
  fuses.json                fuse families, ratings, holders, selection rule
  connectors.json           Deutsch, Metri-Pack, lugs, splices, sleeving
  accessories.json          shipped accessory catalogue (seeds the editable one)

src/lib/loom/               the engineering core, no React
  types.ts                  Loom / LoomNode / LoomEdge / LoomSegment / settings
  data.ts                   typed accessors + derating over /data
  wire-sizing.ts            sizeWire()
  fuse-selection.ts         selectFuse()
  segments.ts               bundle routing, diameter, sleeving
  mutations.ts              splice/split/duplicate/delete, pure functions
  analysis.ts               analyseLoom() — the single entry point
  bom.ts                    BOM, cut list, CSV
  formboard.ts              board layout, trunk geometry, scale
  accessories.ts            catalogue types and node construction
  demo-loom.ts              seeded service-body loom

src/lib/db/                 persistence behind one interface
src/lib/export/             PDF drawing and download helpers
src/components/             canvas, formboard, inspector, summary, ui primitives
src/routes/                 / , /looms/$loomId , /accessories
supabase/migrations/        schema + RLS
```

`analyseLoom()` is the single entry point. The UI, the CSVs and the PDF all call
it, so they cannot disagree about a wire size.

## Two layers: wires and bundles

**An edge is a wire. A segment is the bundle it travels inside.** Segments are
the physical path on the board — the trunk and every branch off it. Wires are
routed *through* segments, by shortest physical route unless the wire names its
own path. This is why the board draws a thick taped trunk with breakouts rather
than a fan of loose lines.

Sleeving, conduit and tape belong to a **segment**, never to a wire, because
that is how they are fitted. Bundle diameter is derived from the conductors
inside at 75 % packing plus a tape allowance, and the sleeve is chosen from it.

A run with `lengthFromRouting` takes its cut length from the segments it passes
through plus its tails. That is the point of a trunk: lengthen the trunk and
every wire inside it re-lengths. Runs without it keep their authored length, and
a disagreement of more than 10 % is reported.

A loom with no segments still works — every wire is unrouted and drawn loose,
which is what the tool did before this layer existed.

## Rules that are not obvious from the code

**Never hardcode an engineering number.** Ampacities, resistances, fuse ratings,
derating factors and drop budgets all come from `/data` via `src/lib/loom/data.ts`.
If you find yourself typing `19` for 16 AWG, stop.

**Wire sizing has three constraints, not two.** Smallest size where current ≤
derated ampacity, drop ≤ the class budget (3 % power, 2 % charging, 10 % signal),
**and** on a protected run a real standard fuse rating exists between 1.25 × current
and the conductor's rating. That third one is easy to miss and it is why the demo
inverter feed is 3/0 and not 2 AWG. Ground returns and unfused runs skip it.
`SizingResult.limitingConstraint` reports which one bound the size.

**AS/NZS 3808 is the default ampacity basis**, chosen for NZ hand-build. SAE J1128
is selectable per loom for international manufacture. The two disagree materially
— 1/0 AWG is 174 A on one and 245 A on the other — so never assert one as fact in
a message. Where a value came from the fitted curve rather than a published table
the row is flagged `interpolated` and the issue is raised at **info** severity,
because it is provenance, not a defect.

**A specified fuse rating is validated, never overwritten.** Vendor kit figures
(Redarc FK60 is 60 A on a 50 A charger, below the 1.25× minimum) are deliberate.
Warn, don't correct.

**Part numbers carry a confidence field.** Deutsch numbers are stated because they
could be. Metri-Pack terminals, ring lugs, splices and fuse holders are `null` with
the selection criteria given instead, and the BOM counts them in
`unresolvedPartNumbers` and prints `CONFIRM FROM CATALOGUE`. Do not invent a part
number to make a line look complete.

**`loom_wires` stores derived data on purpose.** Once a revision goes to the floor
its cut list must not change because someone revised `wire.json`. A release freezes
the schedule and stamps the reference-data revisions it was computed against.

**Splicing a bundled wire splits the bundle too.** `insertSpliceInRun` finds
which segment the distance lands in and breaks it there, so the splice appears
*on* the trunk where a builder needs it, rather than floating beside it with
both halves unrouted. Do not simplify that away.

**Per-run drop budgets do not add up.** Each run is sized against its own 3 %,
so a load at the end of four runs in series can see 3.5 % while every run passes
on its own. `circuit_drop_exceeded` walks source-to-load paths and catches it.
Several demo runs carry a `gaugeOverrideId` purely because of this — the
comments say so, and a test asserts that removing the override brings the
failure back, so they cannot rot into cargo. Proper per-path budget allocation
during sizing is still a gap.

**The drawing is scaled to fit, not 1:1.** So the pinned distance between two nodes
is not the cut length. Every run is dimensioned with its authored length, the sheet
says `NOT TO SCALE FOR MEASUREMENT`, and the formboard view flags loose runs where
the two disagree by more than 10 %. Do not "fix" that warning by reconciling the
numbers silently. Wires inside a bundle are exempt — the bundle owns the geometry,
so comparing a wire to a straight line between its end nodes means nothing.

**jsPDF's standard fonts are WinAnsi-encoded.** `⌀` and other non-Latin-1 glyphs
render as garbage. Write "OD" instead. `·`, `—`, `²` and `×` are all fine.

## Testing

Every calculation change needs a test. Existing tests assert real engineering
outcomes, not just shapes — "is voltage-drop limited on a long low-current run",
"never fuses above the conductor rating", "keeps a release stable when the loom
afterwards changes". Match that.

When changing sizing or derating, expect demo-loom assertions in
`analysis.test.ts` to move. Verify the new numbers are right before updating the
expectations — the tests are the spec, not scaffolding.

Verify UI work in a browser rather than trusting the build. Playwright is not a
dependency; add it temporarily and launch Chromium with
`executablePath: '/opt/pw-browsers/chromium'`. To read a generated PDF,
`pip install pymupdf` and render pages to PNG (there is no poppler).

## Known gaps

- **The Supabase migration has never been run.** Schema, RLS and repository are
  written and the row mapping is round-trip tested, but no live project has been
  touched. Everything demonstrated so far ran on the local-storage repository.
- **No per-path drop budget allocation.** Sizing is per run; the cumulative check
  only reports. Upsizing is manual.
- **No release/freeze UI.** `loom_wires` and `releaseWires()` exist and are tested;
  nothing calls them. Exports always reflect current state.
- **No auth UI.** `getRepository()` picks Supabase only when a user is already
  signed in.
- Formboard runs and bundles are straight lines unless `routing` is set by hand;
  there is no polyline routing editor.
- Wires route through bundles automatically. `edge.segmentIds` forces a path but
  nothing in the UI sets it yet.

## Working branch

`claude/automotive-loom-design-tool-iuvt5h`. Develop and push there. Do not open a
pull request unless asked.
