/**
 * Bill of materials and cut list.
 *
 * Both are derived from the analysis, so what the summary panel shows, what the
 * CSV exports and what the PDF prints are the same numbers by construction.
 *
 * Where a part number could not be stated with confidence the line carries the
 * selection criteria instead and is counted in `unresolvedPartNumbers`, so
 * nobody sends a drawing out believing the BOM is orderable when it isn't.
 */

import { wireReferences, type EdgeAnalysis, type LoomAnalysis } from './analysis'
import {
  connectorSeriesById,
  FUSE_HOLDERS,
  fuseFamilyById,
  insulationById,
  RING_TERMINALS,
  SLEEVING,
  SPLICES,
  type ConnectorSeries,
} from './data'
import type { LoomNode } from './types'

export interface BomLine {
  key: string
  description: string
  partNumber?: string
  /** Set when the number needs confirming against the supplier catalogue. */
  needsPartNumber?: boolean
  quantity: number | string
  unit?: string
  note?: string
}

export interface BomGroup {
  title: string
  lines: BomLine[]
}

export interface Bom {
  groups: BomGroup[]
  unresolvedPartNumbers: number
}

/* ---------------------------------- BOM ----------------------------------- */

export function buildBom(analysis: LoomAnalysis): Bom {
  const groups: BomGroup[] = []
  const defaultInsulation = analysis.loom.settings.defaultInsulationId

  /* wire, grouped by size and insulation */
  const wire = new Map<string, { size: string; insulation: string; length_mm: number; mass_g: number }>()
  for (const e of analysis.edges) {
    if (!e.sizing.size) continue
    const insulationId = e.edge.insulationId ?? defaultInsulation
    const key = `${e.sizing.size.id}::${insulationId}`
    const row = wire.get(key) ?? {
      size: e.sizing.size.label,
      insulation: insulationById(insulationId)?.label ?? insulationId,
      length_mm: 0,
      mass_g: 0,
    }
    row.length_mm += e.effectiveLength_mm
    row.mass_g += (e.effectiveLength_mm / 1000) * e.sizing.size.mass_g_per_m
    wire.set(key, row)
  }
  groups.push({
    title: 'Wire',
    lines: [...wire.entries()]
      .sort((a, b) => b[1].length_mm - a[1].length_mm)
      .map(([key, r]) => ({
        key,
        description: `${r.size} — ${r.insulation}`,
        // Wire is bought by the metre and always cut long; a 10 % allowance is
        // shop practice and stops the first build coming up short.
        quantity: Math.ceil((r.length_mm / 1000) * 1.1 * 10) / 10,
        unit: 'm',
        note: `${(r.length_mm / 1000).toFixed(2)} m net, ${Math.round(r.mass_g)} g, incl. 10 % cutting allowance`,
      })),
  })

  /* connectors */
  const connectorLines: BomLine[] = []
  let unresolved = 0
  for (const node of analysis.loom.nodes) {
    if (!node.connector) continue
    const series = connectorSeriesById(node.connector.seriesId)
    if (!series) continue
    // One pin and one socket per occupied cavity. Counting wires instead would
    // order two of each for a 2-way inline connector carrying one circuit
    // through, which is twice what the bench needs.
    const pinout = analysis.pinouts.find((p) => p.node.id === node.id)
    const used = pinout
      ? pinout.pins.filter((p) => p.circuitId !== null).length
      : countTerminations(analysis, node)
    const housing = series.housings.find((h) => h.ways === node.connector!.ways)
    const spare = Math.max(0, node.connector.ways - used)

    if (housing) {
      connectorLines.push(
        {
          key: `${node.id}-recept`,
          description: `${series.label} ${housing.ways}-way receptacle — ${node.name}`,
          partNumber: housing.receptaclePn,
          quantity: 1,
          note: housing.note,
        },
        {
          key: `${node.id}-plug`,
          description: `${series.label} ${housing.ways}-way plug — ${node.name}`,
          partNumber: housing.plugPn,
          quantity: 1,
        },
        {
          key: `${node.id}-wedges`,
          description: `${series.label} wedgelock pair (${housing.receptacleWedgePn} + ${housing.plugWedgePn})`,
          quantity: 1,
          unit: 'pr',
          note: 'Mandatory — the connector does not retain contacts without it.',
        },
      )
    } else {
      unresolved++
      connectorLines.push({
        key: `${node.id}-housing`,
        description: `${series.label} ${node.connector.ways}-way housing pair — ${node.name}`,
        needsPartNumber: true,
        quantity: 1,
        note: `No ${node.connector.ways}-way housing catalogued for this series — select from the supplier catalogue.`,
      })
    }

    const pin = series.contacts.find((c) => c.role === 'pin' || c.role === 'male')
    const socket = series.contacts.find((c) => c.role === 'socket' || c.role === 'female')
    for (const [contact, role] of [
      [pin, 'pin'],
      [socket, 'socket'],
    ] as const) {
      if (!contact || used === 0) continue
      if (!contact.pn) unresolved++
      connectorLines.push({
        key: `${node.id}-${role}`,
        description: `${series.label} ${role} contact${contact.pn ? '' : ` (${contact.type})`}`,
        partNumber: contact.pn ?? undefined,
        needsPartNumber: !contact.pn,
        quantity: used,
        note: contact.pn ? undefined : contact.note ?? 'Select from the supplier catalogue.',
      })
    }

    const seal = series.accessories.find((a) => a.role.includes('seal'))
    if (spare > 0 && seal) {
      if (!seal.pn) unresolved++
      connectorLines.push({
        key: `${node.id}-seals`,
        description: `${series.label} cavity seal plug`,
        partNumber: seal.pn ?? undefined,
        needsPartNumber: !seal.pn,
        quantity: spare,
        note: 'One per unused cavity — omitting these voids the IP rating.',
      })
    }
  }
  if (connectorLines.length) groups.push({ title: 'Connectors', lines: connectorLines })

  /* ring terminals and lugs at studs */
  const terminationLines: BomLine[] = []
  const lugCounts = new Map<string, number>()
  for (const e of analysis.edges) {
    if (!e.sizing.size) continue
    for (const node of [e.fromNode, e.toNode]) {
      if (!needsRingTerminal(node)) continue
      const lug = RING_TERMINALS.find(
        (t) => e.sizing.size!.area_mm2 >= t.wireRange_mm2[0]! && e.sizing.size!.area_mm2 <= t.wireRange_mm2[1]!,
      )
      const key = lug?.id ?? `unmatched-${e.sizing.size.id}`
      lugCounts.set(key, (lugCounts.get(key) ?? 0) + 1)
    }
  }
  for (const [key, quantity] of lugCounts) {
    const lug = RING_TERMINALS.find((t) => t.id === key)
    if (!lug) {
      unresolved++
      terminationLines.push({
        key,
        description: `Ring terminal — no catalogued size matches this conductor`,
        needsPartNumber: true,
        quantity,
        note: 'Select a lug for this conductor area and stud size.',
      })
      continue
    }
    if (!lug.pn) unresolved++
    terminationLines.push({
      key,
      description: lug.label,
      partNumber: lug.pn ?? undefined,
      needsPartNumber: !lug.pn,
      quantity,
      note: lug.note,
    })
  }
  if (terminationLines.length) groups.push({ title: 'Terminations', lines: terminationLines })

  /* protection */
  const fuseCounts = new Map<string, { description: string; quantity: number }>()
  const holderCounts = new Map<string, number>()
  for (const e of analysis.edges) {
    const selected = e.fuse?.selected
    if (!selected) continue
    const family = fuseFamilyById(selected.familyId)
    const key = `${selected.familyId}-${selected.rating_a}`
    const existing = fuseCounts.get(key)
    if (existing) existing.quantity++
    else
      fuseCounts.set(key, {
        description: `${selected.rating_a} A ${family?.label ?? selected.familyId}${
          family?.bodyColorByRating?.[String(selected.rating_a)]
            ? ` (${family.bodyColorByRating[String(selected.rating_a)]})`
            : ''
        }`,
        quantity: 1,
      })
    const holderId = e.edge.protection?.holderId
    if (holderId) holderCounts.set(holderId, (holderCounts.get(holderId) ?? 0) + 1)
  }
  const protectionLines: BomLine[] = [
    ...[...fuseCounts.entries()].map(([key, v]) => ({
      key,
      description: v.description,
      quantity: v.quantity,
      note: 'Add spares to the vehicle kit.',
    })),
    ...[...holderCounts.entries()].map(([id, quantity]) => {
      const holder = FUSE_HOLDERS.find((h) => h.id === id)
      if (holder?.partNumber?.startsWith('generic-')) unresolved++
      return {
        key: id,
        description: holder?.label ?? id,
        partNumber: holder?.partNumber?.startsWith('generic-') ? undefined : holder?.partNumber,
        needsPartNumber: holder?.partNumber?.startsWith('generic-') ?? true,
        quantity,
        note: holder?.notes,
      }
    }),
  ]
  if (protectionLines.length) groups.push({ title: 'Protection', lines: protectionLines })

  /* splices */
  const spliceCounts = new Map<string, number>()
  for (const node of analysis.loom.nodes) {
    if (node.kind !== 'splice' || !node.splice?.spliceId) continue
    spliceCounts.set(node.splice.spliceId, (spliceCounts.get(node.splice.spliceId) ?? 0) + 1)
  }
  if (spliceCounts.size) {
    groups.push({
      title: 'Splices',
      lines: [...spliceCounts.entries()].map(([id, quantity]) => {
        const splice = SPLICES.find((s) => s.id === id)
        if (!splice?.pn) unresolved++
        return {
          key: id,
          description: splice?.label ?? id,
          partNumber: splice?.pn ?? undefined,
          needsPartNumber: !splice?.pn,
          quantity,
          note: splice?.note,
        }
      }),
    })
  }

  /* sleeving and ties, taken from the bundle segments */
  const sleeving = sleevingLines(analysis)
  const ties = tieLines(analysis)
  if (sleeving.length || ties.length) {
    unresolved += sleeving.length + ties.length
    groups.push({ title: 'Protection sleeving', lines: [...sleeving, ...ties] })
  }

  return { groups, unresolvedPartNumbers: unresolved }
}

/** A stud or busbar termination needs a ring terminal; a connector does not. */
function needsRingTerminal(node: LoomNode): boolean {
  if (node.kind === 'ground') return true
  if (node.kind === 'source') return true
  return node.kind === 'splice' && node.splice?.method === 'busbar'
}

function countTerminations(analysis: LoomAnalysis, node: LoomNode): number {
  return analysis.edges.filter(
    (e) => e.edge.fromNodeId === node.id || e.edge.toNodeId === node.id,
  ).length
}

/**
 * Sleeving taken from the segments themselves rather than guessed.
 *
 * Where a segment has sleeving specified we order that; where it has none but
 * the bundle diameter calls for some, the recommendation is listed separately
 * so running bare is a decision rather than an omission.
 */
function sleevingLines(analysis: LoomAnalysis): BomLine[] {
  const specified = new Map<string, number>()
  const recommended = new Map<string, number>()
  for (const load of analysis.segments) {
    if (load.edgeIds.length === 0) continue
    const sleeve = load.sleeving ?? load.recommendedSleeving
    if (!sleeve) continue
    const target = load.sleeving ? specified : recommended
    target.set(sleeve.id, (target.get(sleeve.id) ?? 0) + load.segment.length_mm)
  }

  const metres = (mm: number) => Math.ceil((mm / 1000) * 1.1 * 10) / 10
  const lines: BomLine[] = []
  for (const [id, length_mm] of specified) {
    lines.push({
      key: `sleeve-${id}`,
      description: SLEEVING.find((s) => s.id === id)?.label ?? id,
      quantity: metres(length_mm),
      unit: 'm',
      needsPartNumber: true,
      note: `${(length_mm / 1000).toFixed(2)} m of bundle, incl. 10 % allowance`,
    })
  }
  for (const [id, length_mm] of recommended) {
    lines.push({
      key: `sleeve-rec-${id}`,
      description: `${SLEEVING.find((s) => s.id === id)?.label ?? id} — recommended, not specified`,
      quantity: metres(length_mm),
      unit: 'm',
      needsPartNumber: true,
      note: 'No sleeving set on these bundles. Confirm whether they are meant to run bare.',
    })
  }
  return lines
}

/** Tape wraps and ties placed along the bundles. */
function tieLines(analysis: LoomAnalysis): BomLine[] {
  const ties = analysis.segments.reduce((t, s) => t + (s.segment.ties?.length ?? 0), 0)
  if (ties === 0) return []
  return [
    {
      key: 'ties',
      description: 'Cable tie / tape wrap at marked positions',
      quantity: ties,
      needsPartNumber: true,
      note: 'One per tie mark on the formboard.',
    },
  ]
}

/* -------------------------------- cut list -------------------------------- */

export interface CutListRow {
  /**
   * Unique label for this physical wire. Equal to the circuit id when the
   * circuit is a single run, suffixed /1, /2 … when a circuit is built from
   * several — otherwise two different wires go on the bench with the same
   * label and the wrong one gets fitted.
   */
  wireRef: string
  circuitId: string
  edgeId: string
  /** Cavity at each end, when that end is a connector. */
  fromCavity: string
  toCavity: string
  from: string
  fromLocation: string
  to: string
  toLocation: string
  length_mm: number
  size: string
  area_mm2: number | null
  insulation: string
  color: string
  current_a: number
  voltageDropPct: number
  limitingConstraint: string
  fuse: string
  notes: string
}

export function buildCutList(analysis: LoomAnalysis): CutListRow[] {
  const defaultInsulation = analysis.loom.settings.defaultInsulationId
  const refs = wireReferences(analysis.edges)
  // Which cavity each wire lands in, from the derived pin-outs.
  const cavityOf = new Map<string, string>()
  for (const pinout of analysis.pinouts) {
    for (const pin of pinout.pins) {
      for (const e of pin.edges) cavityOf.set(`${pinout.node.id}::${e.edge.id}`, String(pin.cavity))
    }
  }
  return [...analysis.edges]
    .sort((a, b) => a.edge.circuitId.localeCompare(b.edge.circuitId, undefined, { numeric: true }))
    .map((e: EdgeAnalysis) => {
      return {
      wireRef: refs.get(e.edge.id) ?? e.edge.circuitId,
      circuitId: e.edge.circuitId,
      fromCavity: cavityOf.get(`${e.edge.fromNodeId}::${e.edge.id}`) ?? '',
      toCavity: cavityOf.get(`${e.edge.toNodeId}::${e.edge.id}`) ?? '',
      edgeId: e.edge.id,
      from: e.fromNode.name,
      fromLocation: e.fromNode.location,
      to: e.toNode.name,
      toLocation: e.toNode.location,
      length_mm: Math.round(e.effectiveLength_mm),
      size: e.sizing.size?.label ?? 'UNSIZED',
      area_mm2: e.sizing.size?.area_mm2 ?? null,
      insulation:
        insulationById(e.edge.insulationId ?? defaultInsulation)?.label ??
        (e.edge.insulationId ?? defaultInsulation),
      color: e.color,
      current_a: Number(e.current_a.toFixed(2)),
      voltageDropPct: Number(e.sizing.voltageDropPct.toFixed(2)),
      limitingConstraint: e.sizing.limitingConstraint,
      fuse: e.fuse?.selected ? `${e.fuse.selected.rating_a} A ${e.fuse.selected.familyLabel}` : '',
      notes: e.edge.notes ?? '',
      }
    })
}

/** RFC 4180 CSV. Quotes everything so a comma in a location never splits a cell. */
export function toCsv(rows: Record<string, unknown>[], headers?: string[]): string {
  if (!rows.length) return ''
  const keys = headers ?? Object.keys(rows[0]!)
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join(
    '\r\n',
  )
}

export function cutListCsv(analysis: LoomAnalysis): string {
  return toCsv(buildCutList(analysis) as unknown as Record<string, unknown>[])
}

/** One row per cavity, so a pin-out can go on the bench as a spreadsheet. */
export function pinoutCsv(analysis: LoomAnalysis): string {
  const rows = analysis.pinouts.flatMap((pinout) =>
    pinout.pins.map((pin) => ({
      connector: pinout.node.name,
      location: pinout.node.location,
      series: pinout.series?.label ?? '',
      ways: pinout.ways,
      cavity: pin.cavity,
      circuit: pin.circuitId ?? '',
      wireRefs: pin.wireRefs.join(' / '),
      size: pin.size,
      current_a: pin.circuitId ? pin.current_a.toFixed(2) : '',
      direction: pin.direction ?? '',
      destination: pin.destination,
      assignment: pin.circuitId
        ? pin.explicit
          ? 'specified'
          : 'auto'
        : 'EMPTY — fit sealing plug',
    })),
  )
  return toCsv(rows)
}

export function bomCsv(analysis: LoomAnalysis): string {
  const bom = buildBom(analysis)
  const rows = bom.groups.flatMap((g) =>
    g.lines.map((l) => ({
      group: g.title,
      description: l.description,
      partNumber: l.partNumber ?? '',
      confirmPartNumber: l.needsPartNumber ? 'YES' : '',
      quantity: l.quantity,
      unit: l.unit ?? 'ea',
      note: l.note ?? '',
    })),
  )
  return toCsv(rows)
}

export { type ConnectorSeries }
