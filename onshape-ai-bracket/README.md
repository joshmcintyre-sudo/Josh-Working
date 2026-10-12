# Onshape AI Bracket panel

Type a bracket request in a side panel inside an Onshape Part Studio → get a sized, parametric part inserted into the feature tree.

```
Onshape right panel (iframe)  ->  Node server  ->  Claude: English -> JSON spec
        ^                              |          engineering.js: sizes thickness/width (deterministic)
        |                              v
   Part Studio regenerates  <-  Onshape REST API: adds "AI Bracket" custom feature (FeatureScript)
```

**Why the split:** the LLM only reads intent (holes, spacing, load, material). Strength maths is plain code with formulas shown in the panel, so the answer is repeatable and checkable.

## What's possible in Onshape (summary)

| Option | Can call AI? | Use for |
|---|---|---|
| FeatureScript custom feature | No (no network) | The geometry. Parametric, editable after insert |
| Extension, "Element right panel" | Yes (it's your web page) | The chat/query sidebar. This project |
| REST API (`/partstudios/.../features`) | n/a | Inserting features, reading mass props, exporting STEP |
| App Store app (OAuth) | Yes | Same as this, rolled out to the whole company |

Refs: [Extensions](https://onshape-public.github.io/docs/app-dev/extensions/) · [Features API](https://onshape-public.github.io/docs/api-adv/featureaccess/) · [FeatureScript std](https://cad.onshape.com/FsDoc/) · [API Explorer](https://cad.onshape.com/glassworks/explorer)

## Setup (≈20 min)

1. **Feature Studio** – In a new Onshape doc (e.g. "AI Library") create a Feature Studio. Keep the two header lines Onshape writes, paste `featurescript/aiBracket.fs` below them, commit. Create a **version** (Versions → Create version).
   From the URL `https://cad.onshape.com/documents/<FS_DOCUMENT_ID>/v/<FS_VERSION_ID>/e/<FS_ELEMENT_ID>` copy the three IDs.
2. **Keys** – Onshape API keys at <https://dev-portal.onshape.com/keys> (scopes: read + write). Anthropic key at <https://console.anthropic.com>.
3. **Run**
   ```bash
   cd onshape-ai-bracket
   cp .env.example .env   # fill in
   npm install && npm test && npm start
   npx cloudflared tunnel --url http://localhost:3000   # HTTPS URL Onshape can iframe (or ngrok)
   ```
   For a permanent host: Render / Fly.io / Azure App Service (Sydney region `australiaeast` for AU latency).
4. **Extension** – <https://dev-portal.onshape.com> → OAuth applications → create (any redirect URL) → Extensions → Add:
   - Location: **Element right panel**, Context: **Part Studio**
   - Action URL:
     `https://<your-host>/?documentId={$documentId}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}&token=<PANEL_TOKEN>`
   - Grant yourself the app (Applications tab → your app → "Grant"/subscribe), refresh Onshape. A new icon appears in the Part Studio right-hand panel.

## Use

Example prompts:
- `make a bracket that mounts an M6 hole to an M8 bracket 35mm apart, strong enough to hold 25kg`
- `aluminium L bracket, M10 to the canopy frame, M8 load 60mm out, 40kg, vehicle mounted`
- `3D printed flat strap, two M5 holes 80mm apart, 5kg pull`

Follow-ups edit the current design: `make it stainless`, `SF 5`, `spacing 50`.

### Worked example – your request

`M6 → M8, 35 mm, 25 kg` parsed as angle bracket, cantilever, mild steel Gr250, SF 3:

| Item | Value |
|---|---|
| Working / design load | 245 N / 736 N |
| Bending moment (design) | 736 N × 35 mm = 25,751 N·mm |
| Required t | √(6·25751 / (27·250)) = **4.78 → 5 mm** |
| Width | 27 mm (edge distance 1.5 × Ø9 clearance each side) |
| Legs | base 32.5, upright 45, inside bend R5 |
| Holes | Ø9.0 (M8), Ø6.6 (M6), ISO 273 medium |
| Bolt utilisation (8.8) | M8 4 %, M6 8 % |
| Deflection @ 25 kg | 0.06 mm |
| Mass | 73 g |

Same request in 6061-T6 → 5 mm, 25 g. As a straight flat link in tension → 1.6 mm steel is enough (hole tear-out governs).

## Checks performed (`src/engineering.js`)

- Net-section tension at holes, bearing (1.5·Sy), tear-out (2 shear planes, 0.6·Sy)
- Plate bending at the bend / mount hole: σ = 6M / (b t²)
- Bolt capacity, grade 8.8 (ISO 898-1 proof 580 MPa)
- Tip deflection (warns > L/100), plastics creep, 6061-T6 bend cracking
- Edge distance ≥ 1.5 d₀ (EN 1993-1-8 minimum 1.2 d₀; AS 4100 cl. 9.6.2 similar)

Materials: Gr250 steel (AS/NZS 3678 / ASTM A36), 6061-T6, 5052-H32, 304 SS, PETG, PLA. Add more in `MATERIALS`.

**Not covered:** fatigue (vehicle vibration – use SF 5 and avoid sharp corners), weld design, buckling of long thin legs, the structure the M8 bolts into. Treat output as a first-pass size; sign-off still needs an engineer for anything safety-critical.

## Extending

- New part types (gussets, U-clamps, tube clamps): add a branch in `aiBracket.fs`, a `buildGeometry` case and a schema enum value.
- Swap the bracket-only schema for tool use (`create_bracket`, `create_plate`, `add_fillet`) once you have more than ~3 part types.
- Read back mass props to confirm: `GET /api/v10/partstudios/d/{did}/w/{wid}/e/{eid}/massproperties`.

## Files

```
server.js                    Express: /api/design, /api/resize, /api/insert, serves the panel
public/index.html            Side-panel UI
src/llm.js                   Claude call, structured JSON spec, refusal fallback on
src/engineering.js           Sizing + checks (no AI)
src/onshape.js               REST: add custom feature to the open Part Studio
featurescript/aiBracket.fs   Parametric flat-link / L-bracket feature
test/engineering.test.js     npm test
```
