/**
 * Row <-> domain mapping.
 *
 * Kept in one place and round-trip tested, so the shape stored in Postgres and
 * the shape the calculation module consumes can never drift apart silently.
 */

import type { LoomAnalysis } from '~/lib/loom/analysis'
import { ACCESSORY_META, type Accessory } from '~/lib/loom/accessories'
import { CONNECTOR_META, FUSE_META, WIRE_META } from '~/lib/loom/data'
import type {
  ConnectorSpec,
  GroundSpec,
  LoadSpec,
  Loom,
  LoomEdge,
  LoomNode,
  LoomSegment,
  LoomSettings,
  NodeKind,
  ProtectionSpec,
  ReturnPath,
  SourceSpec,
  SpliceSpec,
  WireClass,
  WireFamily,
} from '~/lib/loom/types'
import type {
  AccessoryRow,
  LoomEdgeRow,
  LoomNodeRow,
  LoomRow,
  LoomSegmentRow,
  LoomWireRow,
} from './schema'

const j = <T,>(v: unknown): T | undefined => (v == null ? undefined : (v as T))

/* --------------------------------- loom ---------------------------------- */

export function loomFromRows(
  loom: LoomRow,
  nodes: LoomNodeRow[],
  edges: LoomEdgeRow[],
  segments: LoomSegmentRow[] = [],
): Loom {
  return {
    id: loom.id,
    name: loom.name,
    description: loom.description ?? undefined,
    revision: loom.revision,
    settings: loom.settings as LoomSettings,
    formboard: j<{ width_mm: number; height_mm: number }>(loom.formboard),
    nodes: nodes.map(nodeFromRow),
    edges: edges.map(edgeFromRow),
    ...(segments.length ? { segments: segments.map(segmentFromRow) } : {}),
  }
}

export function segmentFromRow(r: LoomSegmentRow): LoomSegment {
  return {
    id: r.segment_key,
    fromNodeId: r.from_node_key,
    toNodeId: r.to_node_key,
    length_mm: Number(r.length_mm),
    routing: j<{ x: number; y: number }[]>(r.routing),
    sleevingId: r.sleeving_id ?? undefined,
    ties: j<number[]>(r.ties),
    label: r.label ?? undefined,
    notes: r.notes ?? undefined,
  }
}

export function segmentToRow(loomId: string, s: LoomSegment): LoomSegmentRow {
  return {
    loom_id: loomId,
    segment_key: s.id,
    from_node_key: s.fromNodeId,
    to_node_key: s.toNodeId,
    length_mm: s.length_mm,
    routing: s.routing ?? null,
    sleeving_id: s.sleevingId ?? null,
    ties: s.ties ?? null,
    label: s.label ?? null,
    notes: s.notes ?? null,
  }
}

export function nodeFromRow(r: LoomNodeRow): LoomNode {
  return {
    id: r.node_key,
    kind: r.kind as NodeKind,
    name: r.name,
    location: r.location,
    position: r.position as { x: number; y: number },
    formboardPosition: j<{ x: number; y: number }>(r.formboard_position),
    load: j<LoadSpec>(r.load),
    source: j<SourceSpec>(r.source),
    ground: j<GroundSpec>(r.ground),
    connector: j<ConnectorSpec>(r.connector),
    splice: j<SpliceSpec>(r.splice),
    protection: j<ProtectionSpec>(r.protection),
    notes: r.notes ?? undefined,
  }
}

export function nodeToRow(loomId: string, n: LoomNode): LoomNodeRow {
  return {
    loom_id: loomId,
    node_key: n.id,
    kind: n.kind,
    name: n.name,
    location: n.location,
    position: n.position,
    formboard_position: n.formboardPosition ?? null,
    load: n.load ?? null,
    source: n.source ?? null,
    ground: n.ground ?? null,
    connector: n.connector ?? null,
    splice: n.splice ?? null,
    protection: n.protection ?? null,
    notes: n.notes ?? null,
  }
}

export function edgeFromRow(r: LoomEdgeRow): LoomEdge {
  return {
    id: r.edge_key,
    fromNodeId: r.from_node_key,
    toNodeId: r.to_node_key,
    circuitId: r.circuit_id,
    label: r.label ?? undefined,
    length_mm: Number(r.length_mm),
    class: r.class as WireClass,
    returnPath: r.return_path as ReturnPath,
    insulationId: r.insulation_id ?? undefined,
    gaugeOverrideId: r.gauge_override_id ?? undefined,
    family: (r.family as WireFamily | null) ?? undefined,
    currentOverride_a: r.current_override_a == null ? undefined : Number(r.current_override_a),
    colorOverride: r.color_override ?? undefined,
    bundleCount: r.bundle_count ?? undefined,
    ambient_c: r.ambient_c == null ? undefined : Number(r.ambient_c),
    routing: j<{ x: number; y: number }[]>(r.routing),
    protection: j<ProtectionSpec>(r.protection),
    notes: r.notes ?? undefined,
    segmentIds: j<string[]>(r.segment_keys),
    lengthFromRouting: r.length_from_routing ?? undefined,
    tails_mm:
      r.tail_from_mm == null && r.tail_to_mm == null
        ? undefined
        : { from: Number(r.tail_from_mm ?? 0), to: Number(r.tail_to_mm ?? 0) },
  }
}

export function edgeToRow(loomId: string, e: LoomEdge): LoomEdgeRow {
  return {
    loom_id: loomId,
    edge_key: e.id,
    from_node_key: e.fromNodeId,
    to_node_key: e.toNodeId,
    circuit_id: e.circuitId,
    label: e.label ?? null,
    length_mm: e.length_mm,
    class: e.class,
    return_path: e.returnPath,
    insulation_id: e.insulationId ?? null,
    gauge_override_id: e.gaugeOverrideId ?? null,
    family: e.family ?? null,
    current_override_a: e.currentOverride_a ?? null,
    color_override: e.colorOverride ?? null,
    bundle_count: e.bundleCount ?? null,
    ambient_c: e.ambient_c ?? null,
    routing: e.routing ?? null,
    protection: e.protection ?? null,
    notes: e.notes ?? null,
    segment_keys: e.segmentIds ?? null,
    length_from_routing: e.lengthFromRouting ?? null,
    tail_from_mm: e.tails_mm?.from ?? null,
    tail_to_mm: e.tails_mm?.to ?? null,
  }
}

/* ------------------------------ wire release ------------------------------ */

/**
 * The reference data revisions a release was computed against. Stored with the
 * frozen schedule so a drawing on the shop floor can be traced back to the
 * exact tables that produced it.
 */
export function currentDataRevisions() {
  return {
    wire: WIRE_META.revision,
    connectors: CONNECTOR_META.revision,
    fuses: FUSE_META.revision,
    accessories: ACCESSORY_META.revision,
  }
}

/** Freeze an analysis into the wire schedule rows for a released revision. */
export function wireRowsFromAnalysis(
  loomId: string,
  revision: string,
  analysis: LoomAnalysis,
): LoomWireRow[] {
  const revisions = currentDataRevisions()
  return analysis.edges
    .filter((e) => e.sizing.size !== null)
    .map((e) => ({
      loom_id: loomId,
      revision,
      edge_key: e.edge.id,
      circuit_id: e.edge.circuitId,
      current_a: e.current_a,
      length_mm: e.effectiveLength_mm,
      wire_size_id: e.sizing.size!.id,
      wire_label: e.sizing.size!.label,
      area_mm2: e.sizing.size!.area_mm2,
      insulation_id: e.edge.insulationId ?? analysis.loom.settings.defaultInsulationId,
      color: e.color,
      voltage_drop_v: e.sizing.voltageDrop_v,
      voltage_drop_pct: e.sizing.voltageDropPct,
      drop_limit_pct: e.sizing.dropLimitPct,
      derated_ampacity_a: e.sizing.deratedAmpacity_a,
      limiting_constraint: e.sizing.limitingConstraint,
      ampacity_basis: e.sizing.basis,
      fuse_family_id: e.fuse?.selected?.familyId ?? null,
      fuse_rating_a: e.fuse?.selected?.rating_a ?? null,
      rationale: e.sizing.rationale,
      data_revisions: revisions,
    }))
}

/* ------------------------------ accessories ------------------------------- */

export function accessoryFromRow(r: AccessoryRow): Accessory {
  return {
    id: r.catalog_key,
    name: r.name,
    brand: r.brand,
    exampleModel: r.example_model,
    category: r.category,
    loadClass: r.load_class as Accessory['loadClass'],
    runCurrentA: Number(r.run_current_a),
    inrushA: r.inrush_a == null ? null : Number(r.inrush_a),
    fuseA: r.fuse_a == null ? 0 : Number(r.fuse_a),
    fuseType: (r.fuse_type ?? 'ATO') as Accessory['fuseType'],
    connector: (r.connector ?? 'DT') as Accessory['connector'],
    ways: r.ways,
    ground: r.ground as Accessory['ground'],
    cableStartMm2: r.cable_start_mm2 == null ? 0 : Number(r.cable_start_mm2),
    driveVia: (r.drive_via as Accessory['driveVia']) ?? null,
    ref: r.ref,
    notes: r.notes,
  }
}

export function accessoryToRow(
  ownerId: string,
  a: Accessory,
  opts: { id?: string; isStock?: boolean; inrushMs?: number | null } = {},
): AccessoryRow {
  return {
    id: opts.id ?? '',
    owner_id: ownerId,
    catalog_key: a.id,
    name: a.name,
    brand: a.brand,
    example_model: a.exampleModel,
    category: a.category,
    load_class: a.loadClass,
    run_current_a: a.runCurrentA,
    inrush_a: a.inrushA,
    inrush_ms: opts.inrushMs ?? null,
    fuse_a: a.fuseA || null,
    fuse_type: a.fuseType,
    connector: a.connector,
    ways: a.ways,
    ground: a.ground,
    cable_start_mm2: a.cableStartMm2 || null,
    drive_via: a.driveVia,
    ref: a.ref,
    notes: a.notes,
    is_stock: opts.isStock ?? true,
  }
}
