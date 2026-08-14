/**
 * Inspector for the selected node or run.
 *
 * For a run it shows the calculation as well as the inputs: the chosen size,
 * the drop against its budget, the derating that was applied and which
 * constraint bound the result. Editing a length here changes the gauge in front
 * of you, which is the whole point of the tool.
 */

import type { EdgeAnalysis, LoomAnalysis } from '~/lib/loom/analysis'
import {
  CONNECTOR_SERIES,
  FUSE_FAMILIES,
  INSULATIONS,
  SLEEVING,
  sizesForFamily,
  type WireSize,
} from '~/lib/loom/data'
import type {
  Duty,
  Loom,
  LoomEdge,
  LoomNode,
  LoomSegment,
  NodeKind,
  ReturnPath,
  WireClass,
  WireFamily,
} from '~/lib/loom/types'
import { amps, cn, mm, pct } from '~/lib/utils'
import type { Selection } from './schematic-canvas'
import { Badge, Button, EmptyState, Field, Input, NumberInput, Select, Textarea } from './ui'

const NODE_KINDS: NodeKind[] = ['source', 'load', 'splice', 'ground', 'connector']
const WIRE_CLASSES: WireClass[] = ['power', 'charging', 'signal', 'ground', 'starter']
const RETURN_PATHS: { value: ReturnPath; label: string }[] = [
  { value: 'modeled', label: 'Return drawn as its own run' },
  { value: 'chassis', label: 'Chassis / body return' },
  { value: 'implied_return', label: 'Return not drawn (drop doubled)' },
]
const DUTIES: Duty[] = ['continuous', 'intermittent', 'momentary']

export function Inspector({
  loom,
  analysis,
  selection,
  onPatchNode,
  onPatchEdge,
  onPatchSegment,
  onRemoveNode,
  onRemoveEdge,
  onRemoveSegment,
}: {
  loom: Loom
  analysis: LoomAnalysis
  selection: Selection
  onPatchNode: (id: string, patch: Partial<LoomNode>) => void
  onPatchEdge: (id: string, patch: Partial<LoomEdge>) => void
  onPatchSegment: (id: string, patch: Partial<LoomSegment>) => void
  onRemoveNode: (id: string) => void
  onRemoveEdge: (id: string) => void
  onRemoveSegment: (id: string) => void
}) {
  if (!selection) {
    return <EmptyState title="Nothing selected">Pick a node or a run on the canvas.</EmptyState>
  }
  if (selection.kind === 'node') {
    const node = loom.nodes.find((n) => n.id === selection.id)
    if (!node) return <EmptyState title="That node has gone." />
    return (
      <NodeInspector
        node={node}
        analysis={analysis}
        onPatch={(patch) => onPatchNode(node.id, patch)}
        onRemove={() => onRemoveNode(node.id)}
      />
    )
  }
  if (selection.kind === 'segment') {
    const load = analysis.segments.find((s) => s.segment.id === selection.id)
    if (!load) return <EmptyState title="That bundle has gone." />
    return (
      <SegmentInspector
        analysis={analysis}
        load={load}
        onPatch={(patch) => onPatchSegment(selection.id, patch)}
        onRemove={() => onRemoveSegment(selection.id)}
      />
    )
  }
  const ea = analysis.byEdgeId[selection.id]
  if (!ea) return <EmptyState title="That run has gone." />
  return (
    <EdgeInspector
      loom={loom}
      ea={ea}
      onPatch={(patch) => onPatchEdge(ea.edge.id, patch)}
      onRemove={() => onRemoveEdge(ea.edge.id)}
    />
  )
}

/* --------------------------------- nodes ---------------------------------- */

function NodeInspector({
  node,
  analysis,
  onPatch,
  onRemove,
}: {
  node: LoomNode
  analysis: LoomAnalysis
  onPatch: (patch: Partial<LoomNode>) => void
  onRemove: () => void
}) {
  const issues = analysis.issues.filter((i) => i.nodeId === node.id)
  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Kind">
          <Select value={node.kind} onChange={(e) => onPatch({ kind: e.target.value as NodeKind })}>
            {NODE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference">
          <Input value={node.id} disabled />
        </Field>
      </div>

      <Field label="Name">
        <Input value={node.name} onChange={(e) => onPatch({ name: e.target.value })} />
      </Field>
      <Field label="Location on vehicle" hint="Appears on the manufacturing drawing.">
        <Input value={node.location} onChange={(e) => onPatch({ location: e.target.value })} />
      </Field>

      {node.kind === 'load' ? (
        <fieldset className="space-y-2 rounded-md border border-neutral-800 p-2.5">
          <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">Load</legend>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Continuous (A)">
              <NumberInput
                step="0.1"
                value={node.load?.continuousCurrent_a}
                onValueChange={(v) =>
                  onPatch({
                    load: {
                      duty: 'continuous',
                      ...node.load,
                      continuousCurrent_a: v ?? 0,
                    },
                  })
                }
              />
            </Field>
            <Field label="Duty">
              <Select
                value={node.load?.duty ?? 'continuous'}
                onChange={(e) =>
                  onPatch({
                    load: {
                      continuousCurrent_a: 0,
                      ...node.load,
                      duty: e.target.value as Duty,
                    },
                  })
                }
              >
                {DUTIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Inrush (A)" hint="Motors and solenoids: 3-8x continuous.">
              <NumberInput
                step="0.5"
                value={node.load?.inrushCurrent_a}
                onValueChange={(v) =>
                  onPatch({
                    load: { continuousCurrent_a: 0, duty: 'continuous', ...node.load, inrushCurrent_a: v },
                  })
                }
              />
            </Field>
            <Field label="Inrush (ms)" hint="Over 100 ms starts blowing fast fuses.">
              <NumberInput
                step="10"
                value={node.load?.inrushDuration_ms}
                onValueChange={(v) =>
                  onPatch({
                    load: {
                      continuousCurrent_a: 0,
                      duty: 'continuous',
                      ...node.load,
                      inrushDuration_ms: v,
                    },
                  })
                }
              />
            </Field>
          </div>
        </fieldset>
      ) : null}

      {node.kind === 'source' ? (
        <fieldset className="grid grid-cols-2 gap-2 rounded-md border border-neutral-800 p-2.5">
          <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">Source</legend>
          <Field label="Capacity (A)">
            <NumberInput
              value={node.source?.capacity_a}
              onValueChange={(v) =>
                onPatch({
                  source: { nominalVoltage_v: 12, ...node.source, capacity_a: v ?? 0 },
                })
              }
            />
          </Field>
          <Field label="Battery (Ah)">
            <NumberInput
              value={node.source?.batteryCapacity_ah}
              onValueChange={(v) =>
                onPatch({
                  source: {
                    nominalVoltage_v: 12,
                    capacity_a: 0,
                    ...node.source,
                    batteryCapacity_ah: v,
                  },
                })
              }
            />
          </Field>
        </fieldset>
      ) : null}

      {node.kind === 'connector' ? (
        <>
          <fieldset className="grid grid-cols-2 gap-2 rounded-md border border-neutral-800 p-2.5">
            <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">
              Connector
            </legend>
            <Field label="Series">
              <Select
                value={node.connector?.seriesId ?? ''}
                onChange={(e) =>
                  onPatch({ connector: { ways: 2, ...node.connector, seriesId: e.target.value } })
                }
              >
                <option value="">—</option>
                {CONNECTOR_SERIES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} ({s.currentRating_a} A/contact)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ways">
              <NumberInput
                value={node.connector?.ways}
                onValueChange={(v) =>
                  onPatch({
                    connector: { seriesId: '', ...node.connector, ways: v ?? 2 },
                  })
                }
              />
            </Field>
          </fieldset>
          <PinoutEditor node={node} analysis={analysis} onPatch={onPatch} />
        </>
      ) : null}

      <Field label="Protection at this node" hint="Applies to runs leaving this node that have none of their own.">
        <Select
          value={node.protection?.familyId ?? ''}
          onChange={(e) =>
            onPatch({ protection: e.target.value ? { familyId: e.target.value } : undefined })
          }
        >
          <option value="">None</option>
          {FUSE_FAMILIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Notes">
        <Textarea value={node.notes ?? ''} onChange={(e) => onPatch({ notes: e.target.value || undefined })} />
      </Field>

      {issues.length ? (
        <ul className="space-y-1">
          {issues.map((i, k) => (
            <li key={k} className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs text-neutral-300">
              <Badge tone={i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'}>
                {i.severity}
              </Badge>{' '}
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}

      <Button variant="danger" size="sm" onClick={onRemove}>
        Delete node and its runs
      </Button>
    </div>
  )
}

/* --------------------------------- edges ---------------------------------- */

const CONSTRAINT_COPY: Record<string, string> = {
  ampacity: 'Ampacity limited',
  voltage_drop: 'Voltage-drop limited',
  both: 'Ampacity and drop both bind',
  fusibility: 'Upsized so a fuse fits',
  minimum_size: 'At the shop minimum size',
  circuit_match: 'Matched to the rest of its circuit',
  override: 'Manually specified',
}

function EdgeInspector({
  loom,
  ea,
  onPatch,
  onRemove,
}: {
  loom: Loom
  ea: EdgeAnalysis
  onPatch: (patch: Partial<LoomEdge>) => void
  onRemove: () => void
}) {
  const e = ea.edge
  const s = ea.sizing
  const family: WireFamily = e.family ?? loom.settings.defaultFamily
  const sizes: WireSize[] = sizesForFamily(family)
  const dropRatio = s.dropLimitPct > 0 ? s.voltageDropPct / s.dropLimitPct : 0
  const ampRatio = s.deratedAmpacity_a > 0 ? ea.current_a / s.deratedAmpacity_a : 0

  return (
    <div className="space-y-4 p-3">
      <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2.5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-sm text-neutral-100">{s.size?.label ?? 'unsized'}</span>
          <Badge tone={s.limitingConstraint === 'override' ? 'info' : 'neutral'}>
            {CONSTRAINT_COPY[s.limitingConstraint] ?? s.limitingConstraint}
          </Badge>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">{s.rationale}</p>

        <Meter label="Voltage drop" ratio={dropRatio} value={`${pct(s.voltageDropPct)} of ${s.dropLimitPct.toFixed(1)} %`} />
        <Meter
          label="Ampacity"
          ratio={ampRatio}
          value={`${amps(ea.current_a)} of ${amps(s.deratedAmpacity_a)}`}
        />

        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <Row k="Current from" v={ea.currentSource.replace(/_/g, ' ')} />
          <Row k="Drop" v={`${s.voltageDrop_v.toFixed(3)} V`} />
          <Row k="Base ampacity" v={amps(s.baseAmpacity_a)} />
          <Row
            k="Derating"
            v={`${s.derating.ambient.toFixed(2)} amb × ${s.derating.bundle.toFixed(2)} bundle`}
          />
          <Row k="Resistance" v={`${(s.resistance_ohm_per_m * 1000).toFixed(2)} mΩ/m`} />
          <Row k="Basis" v={s.basis === 'as_nzs_3808' ? 'AS/NZS 3808' : 'SAE J1128'} />
          {ea.fuse?.selected ? (
            <Row k="Fuse" v={`${ea.fuse.selected.rating_a} A ${ea.fuse.selected.familyLabel}`} />
          ) : null}
          {s.size ? <Row k="Mass" v={`${((e.length_mm / 1000) * s.size.mass_g_per_m).toFixed(0)} g`} /> : null}
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Circuit ID">
          <Input value={e.circuitId} onChange={(ev) => onPatch({ circuitId: ev.target.value })} />
        </Field>
        <Field label="Length (mm)">
          <NumberInput
            step="10"
            value={e.length_mm}
            onValueChange={(v) => onPatch({ length_mm: v ?? 0 })}
          />
        </Field>
        <Field label="Class">
          <Select value={e.class} onChange={(ev) => onPatch({ class: ev.target.value as WireClass })}>
            {WIRE_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bundle size" hint="Conductors sharing the loom at this point.">
          <NumberInput
            value={e.bundleCount ?? 1}
            onValueChange={(v) => onPatch({ bundleCount: v && v > 1 ? v : undefined })}
          />
        </Field>
        <Field label="Ambient (°C)">
          <NumberInput
            value={e.ambient_c ?? loom.settings.defaultAmbient_c}
            onValueChange={(v) => onPatch({ ambient_c: v })}
          />
        </Field>
        <Field label="Insulation">
          <Select
            value={e.insulationId ?? loom.settings.defaultInsulationId}
            onChange={(ev) => onPatch({ insulationId: ev.target.value })}
          >
            {INSULATIONS.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Return path">
        <Select
          value={e.returnPath}
          onChange={(ev) => onPatch({ returnPath: ev.target.value as ReturnPath })}
        >
          {RETURN_PATHS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Gauge" hint="Leave on Auto to let the calculation choose.">
          <Select
            value={e.gaugeOverrideId ?? ''}
            onChange={(ev) => onPatch({ gaugeOverrideId: ev.target.value || undefined })}
          >
            <option value="">Auto</option>
            {sizes.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Protection">
          <Select
            value={e.protection?.familyId ?? ''}
            onChange={(ev) =>
              onPatch({
                protection: ev.target.value
                  ? { ...e.protection, familyId: ev.target.value }
                  : undefined,
              })
            }
          >
            <option value="">None</option>
            {FUSE_FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {e.protection ? (
        <Field label="Fuse rating (A)" hint="Leave blank to let the rule choose. A vendor's kit rating is kept and checked, not replaced.">
          <NumberInput
            step="0.5"
            value={e.protection.rating_a}
            onValueChange={(v) =>
              onPatch({ protection: { ...e.protection!, rating_a: v } })
            }
          />
        </Field>
      ) : null}

      <Field label="Notes">
        <Textarea value={e.notes ?? ''} onChange={(ev) => onPatch({ notes: ev.target.value || undefined })} />
      </Field>

      <div className="text-[11px] text-neutral-600">
        {ea.fromNode.name} → {ea.toNode.name} · {mm(ea.effectiveLength_mm)}
      </div>

      <Button variant="danger" size="sm" onClick={onRemove}>
        Delete run
      </Button>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-neutral-600">{k}</dt>
      <dd className="text-right font-mono text-neutral-400 tabular-nums">{v}</dd>
    </>
  )
}

function Meter({ label, ratio, value }: { label: string; ratio: number; value: string }) {
  const clamped = Math.min(1, Math.max(0, ratio))
  const tone = ratio > 1 ? 'bg-red-500' : ratio > 0.9 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-neutral-500">
        <span>{label}</span>
        <span className="font-mono tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-800">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${clamped * 100}%` }} />
      </div>
    </div>
  )
}

/* -------------------------------- segments -------------------------------- */

function SegmentInspector({
  analysis,
  load,
  onPatch,
  onRemove,
}: {
  analysis: LoomAnalysis
  load: LoomAnalysis['segments'][number]
  onPatch: (patch: Partial<LoomSegment>) => void
  onRemove: () => void
}) {
  const s = load.segment
  const wires = load.edgeIds
    .map((id) => analysis.byEdgeId[id])
    .filter((e): e is NonNullable<typeof e> => Boolean(e))

  return (
    <div className="space-y-4 p-3">
      <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-neutral-100">{s.label ?? s.id}</span>
          <Badge tone={load.sleevingUndersized ? 'error' : 'neutral'}>
            {load.edgeIds.length} wire{load.edgeIds.length === 1 ? '' : 's'}
          </Badge>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <Row k="Bundle ⌀" v={`${load.bundleOd_mm} mm`} />
          <Row k="Length" v={mm(s.length_mm)} />
          <Row k="Conductor mass" v={`${Math.round(load.mass_g)} g`} />
          <Row
            k="Recommended"
            v={load.recommendedSleeving?.label.replace(/ ID.*/, '') ?? 'none'}
          />
        </dl>
        {load.sleevingUndersized ? (
          <p className="mt-2 rounded border border-red-900/70 bg-red-950/40 p-1.5 text-[11px] text-red-200">
            The fitted sleeving is smaller than the bundle. It will not close.
          </p>
        ) : null}
      </div>

      <Field label="Label">
        <Input value={s.label ?? ''} onChange={(e) => onPatch({ label: e.target.value || undefined })} />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Length (mm)" hint="Runs set to follow the trunk re-length from this.">
          <NumberInput step="10" value={s.length_mm} onValueChange={(v) => onPatch({ length_mm: v ?? 0 })} />
        </Field>
        <Field label="Ties / wraps" hint="Evenly spaced marks on the board.">
          <NumberInput
            value={s.ties?.length ?? 0}
            onValueChange={(v) => {
              const n = Math.max(0, Math.round(v ?? 0))
              onPatch({
                ties: n === 0 ? undefined : Array.from({ length: n }, (_, i) => (i + 1) / (n + 1)),
              })
            }}
          />
        </Field>
      </div>

      <Field label="Sleeving / conduit" hint="Fitted over the whole bundle.">
        <Select
          value={s.sleevingId ?? ''}
          onChange={(e) => onPatch({ sleevingId: e.target.value || undefined })}
        >
          <option value="">None — bare bundle</option>
          {SLEEVING.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.bundleOd_mm[0]}-{p.bundleOd_mm[1]} mm)
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <h3 className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">Wires inside</h3>
        {wires.length === 0 ? (
          <p className="text-[11px] text-neutral-600">Nothing routed through this bundle yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {wires.map((w) => (
              <li key={w.edge.id} className="flex justify-between text-[11px] text-neutral-400">
                <span>{w.edge.circuitId}</span>
                <span className="font-mono text-neutral-600">
                  {w.sizing.size?.label ?? '-'} · {amps(w.current_a)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Field label="Notes">
        <Textarea value={s.notes ?? ''} onChange={(e) => onPatch({ notes: e.target.value || undefined })} />
      </Field>

      <Button variant="danger" size="sm" onClick={onRemove}>
        Delete bundle
      </Button>
    </div>
  )
}

/* --------------------------------- pin-out -------------------------------- */

/**
 * Cavity assignment. Rows the designer has not set are shown as "auto" — the
 * tool fills them in a stable order so the drawing always has a pin-out, but
 * the distinction between a decision and a default is kept visible.
 */
function PinoutEditor({
  node,
  analysis,
  onPatch,
}: {
  node: LoomNode
  analysis: LoomAnalysis
  onPatch: (patch: Partial<LoomNode>) => void
}) {
  const pinout = analysis.pinouts.find((p) => p.node.id === node.id)
  if (!pinout) return null

  // Circuits meeting here, not individual wires: a mated cavity joins one run
  // on each side and both are the same circuit.
  const candidates = [
    ...new Map(
      analysis.edges
        .filter((e) => e.edge.fromNodeId === node.id || e.edge.toNodeId === node.id)
        .map((e) => [e.edge.circuitId, e]),
    ).values(),
  ]

  const setCavity = (cavity: number, circuitId: string) => {
    const next: Record<string, string> = { ...(node.connector?.cavities ?? {}) }
    // A circuit lives in exactly one cavity, so claiming it releases the old.
    for (const [k, v] of Object.entries(next)) if (v === circuitId) delete next[k]
    if (circuitId) next[String(cavity)] = circuitId
    else delete next[String(cavity)]
    onPatch({ connector: { ...node.connector!, cavities: next } })
  }

  return (
    <fieldset className="space-y-1.5 rounded-md border border-neutral-800 p-2.5">
      <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">Pin-out</legend>
      {pinout.pins.map((pin) => (
        <div key={pin.cavity} className="flex items-center gap-1.5">
          <span className="w-5 shrink-0 text-right font-mono text-[11px] text-neutral-500">
            {pin.cavity}
          </span>
          <Select
            className="h-7 text-xs"
            value={pin.circuitId ?? ''}
            onChange={(e) => setCavity(pin.cavity, e.target.value)}
          >
            <option value="">empty — sealing plug</option>
            {candidates.map((c) => (
              <option key={c.edge.circuitId} value={c.edge.circuitId}>
                {c.edge.circuitId} · {c.sizing.size?.label ?? '?'} · {amps(c.current_a)}
              </option>
            ))}
          </Select>
          {pin.circuitId && !pin.explicit ? <Badge tone="neutral">auto</Badge> : null}
          {pin.overCurrent ? <Badge tone="error">over</Badge> : null}
        </div>
      ))}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] text-neutral-600">
          {pinout.contactRating_a.toFixed(1)} A per contact
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const next: Record<string, string> = {}
            pinout.pins.forEach((p) => {
              if (p.circuitId) next[String(p.cavity)] = p.circuitId
            })
            onPatch({ connector: { ...node.connector!, cavities: next } })
          }}
        >
          Accept auto
        </Button>
      </div>
    </fieldset>
  )
}
