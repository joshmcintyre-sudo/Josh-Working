/**
 * Bundle segments — the physical harness layer.
 *
 * An edge is a wire. A segment is the path a group of wires physically travels
 * along: the trunk, and every branch off it. Wires are routed *through*
 * segments, which is what lets the board draw a thick taped trunk with
 * breakouts instead of a fan of loose lines, and what gives sleeving something
 * to be fitted over.
 *
 * Routing is derived from the segment graph unless a wire names its own path.
 * A loom with no segments still works — every wire is simply unrouted and draws
 * as a direct line, which is what the tool did before this layer existed.
 */

import { SLEEVING, wireSizeById, type ProtectionSleeve, type WireSize } from './data'
import type { Loom, LoomEdge, LoomSegment } from './types'

export interface RoutedWire {
  edgeId: string
  /** Segments the wire passes through, in order from the run's `from` end. */
  segmentIds: string[]
  /** Sum of the lengths of those segments. */
  bundleLength_mm: number
  /** Tails beyond the bundle at each end. */
  tails_mm: number
  /** bundleLength + tails. What the wire should be cut to if routed. */
  routedLength_mm: number
  /** True when the wire names its own path rather than taking the derived one. */
  explicit: boolean
  /** Set when the wire could not be routed through the segment graph. */
  unrouted: boolean
}

export interface SegmentLoad {
  segment: LoomSegment
  /** Edge ids travelling through this segment. */
  edgeIds: string[]
  /** Conductor sizes in the bundle, for the diameter estimate. */
  sizes: WireSize[]
  /** Estimated outside diameter of the finished bundle, in millimetres. */
  bundleOd_mm: number
  /** Sleeving fitted, if any. */
  sleeving: ProtectionSleeve | null
  /** Sleeving the diameter calls for, whether or not it is fitted. */
  recommendedSleeving: ProtectionSleeve | null
  /** True when the fitted sleeving is too small for the bundle. */
  sleevingUndersized: boolean
  /** Total conductor mass carried along this segment, in grams. */
  mass_g: number
}

/* -------------------------------- routing --------------------------------- */

/** Adjacency over the segment graph. Segments are undirected physically. */
function segmentGraph(segments: LoomSegment[]): Map<string, { to: string; segment: LoomSegment }[]> {
  const graph = new Map<string, { to: string; segment: LoomSegment }[]>()
  const add = (from: string, to: string, segment: LoomSegment) => {
    graph.set(from, [...(graph.get(from) ?? []), { to, segment }])
  }
  for (const s of segments) {
    add(s.fromNodeId, s.toNodeId, s)
    add(s.toNodeId, s.fromNodeId, s)
  }
  return graph
}

/**
 * Shortest bundle path between two nodes, by total length rather than hop
 * count — a wire follows the shortest physical route, not the fewest branches.
 */
export function findSegmentPath(
  segments: LoomSegment[],
  fromNodeId: string,
  toNodeId: string,
): LoomSegment[] | null {
  if (fromNodeId === toNodeId) return []
  const graph = segmentGraph(segments)
  const best = new Map<string, number>([[fromNodeId, 0]])
  const previous = new Map<string, { node: string; segment: LoomSegment }>()
  const queue = new Set<string>([fromNodeId])

  while (queue.size) {
    let current: string | null = null
    let currentCost = Infinity
    for (const node of queue) {
      const cost = best.get(node) ?? Infinity
      if (cost < currentCost) {
        current = node
        currentCost = cost
      }
    }
    if (current === null) break
    queue.delete(current)
    if (current === toNodeId) break

    for (const { to, segment } of graph.get(current) ?? []) {
      const cost = currentCost + Math.max(0, segment.length_mm)
      if (cost < (best.get(to) ?? Infinity)) {
        best.set(to, cost)
        previous.set(to, { node: current, segment })
        queue.add(to)
      }
    }
  }

  if (!previous.has(toNodeId) && fromNodeId !== toNodeId) return null
  const path: LoomSegment[] = []
  let cursor = toNodeId
  while (cursor !== fromNodeId) {
    const step = previous.get(cursor)
    if (!step) return null
    path.unshift(step.segment)
    cursor = step.node
  }
  return path
}

export function routeWires(loom: Loom): Map<string, RoutedWire> {
  const segments = loom.segments ?? []
  const byId = new Map(segments.map((s) => [s.id, s]))
  const defaultTail = loom.settings.defaultTail_mm ?? 0
  const out = new Map<string, RoutedWire>()

  for (const edge of loom.edges) {
    const tails = (edge.tails_mm?.from ?? defaultTail) + (edge.tails_mm?.to ?? defaultTail)

    let path: LoomSegment[] | null
    let explicit = false
    if (edge.segmentIds?.length) {
      const named = edge.segmentIds.map((id) => byId.get(id)).filter((s): s is LoomSegment => !!s)
      // A named path that references a missing segment is treated as unrouted
      // rather than silently shortened.
      path = named.length === edge.segmentIds.length ? named : null
      explicit = true
    } else if (segments.length === 0) {
      path = null
    } else {
      path = findSegmentPath(segments, edge.fromNodeId, edge.toNodeId)
    }

    const bundleLength = (path ?? []).reduce((t, s) => t + s.length_mm, 0)
    out.set(edge.id, {
      edgeId: edge.id,
      segmentIds: (path ?? []).map((s) => s.id),
      bundleLength_mm: bundleLength,
      tails_mm: tails,
      routedLength_mm: bundleLength + tails,
      explicit,
      unrouted: path === null,
    })
  }
  return out
}

/**
 * The cut length for a wire: from its routing when it is set to follow the
 * trunk, otherwise the authored figure. Service loop is added by the caller.
 */
export function cutLengthFor(edge: LoomEdge, routed: RoutedWire | undefined): number {
  if (edge.lengthFromRouting && routed && !routed.unrouted && routed.segmentIds.length > 0) {
    return routed.routedLength_mm
  }
  return edge.length_mm
}

/* ------------------------------ bundle sizing ------------------------------ */

/**
 * Outside diameter of a bundle of round conductors.
 *
 * Cables pack loosely, so the usual shop approximation is to treat the bundle
 * as a circle whose area is the summed conductor area divided by a packing
 * fraction of about 0.75, then add a little for tape.
 */
export function bundleDiameter(ods_mm: number[]): number {
  if (ods_mm.length === 0) return 0
  if (ods_mm.length === 1) return ods_mm[0]!
  const area = ods_mm.reduce((t, d) => t + Math.PI * (d / 2) ** 2, 0)
  const packed = area / 0.75
  const diameter = 2 * Math.sqrt(packed / Math.PI)
  return Math.round(diameter * 1.08 * 10) / 10
}

/** Conductor OD for a size under a given insulation, falling back sensibly. */
export function conductorOd(size: WireSize, insulationId: string): number {
  return size.od_mm[insulationId] ?? Object.values(size.od_mm)[0] ?? 2
}

export function chooseSleeving(bundleOd_mm: number): ProtectionSleeve | null {
  if (bundleOd_mm <= 0) return null
  return (
    SLEEVING.find((s) => bundleOd_mm >= s.bundleOd_mm[0]! && bundleOd_mm <= s.bundleOd_mm[1]!) ??
    // Nothing catalogued is big enough; offer the largest so the BOM is not
    // silently empty.
    SLEEVING.reduce<ProtectionSleeve | null>(
      (widest, s) => (!widest || s.bundleOd_mm[1]! > widest.bundleOd_mm[1]! ? s : widest),
      null,
    )
  )
}

/**
 * What each segment actually carries: which wires, how fat the bundle is, and
 * whether the sleeving fitted to it is big enough.
 */
export function loadSegments(
  loom: Loom,
  routing: Map<string, RoutedWire>,
  sizeForEdge: (edgeId: string) => WireSize | null,
): SegmentLoad[] {
  const segments = loom.segments ?? []
  const defaultInsulation = loom.settings.defaultInsulationId
  const edgeById = new Map(loom.edges.map((e) => [e.id, e]))

  return segments.map((segment) => {
    const edgeIds: string[] = []
    for (const [edgeId, r] of routing) {
      if (r.segmentIds.includes(segment.id)) edgeIds.push(edgeId)
    }
    edgeIds.sort()

    const sizes: WireSize[] = []
    const ods: number[] = []
    let mass_g = 0
    for (const edgeId of edgeIds) {
      const size = sizeForEdge(edgeId)
      if (!size) continue
      sizes.push(size)
      const insulation = edgeById.get(edgeId)?.insulationId ?? defaultInsulation
      ods.push(conductorOd(size, insulation))
      mass_g += (segment.length_mm / 1000) * size.mass_g_per_m
    }

    const bundleOd_mm = bundleDiameter(ods)
    const recommendedSleeving = chooseSleeving(bundleOd_mm)
    const sleeving = segment.sleevingId
      ? (SLEEVING.find((s) => s.id === segment.sleevingId) ?? null)
      : null

    return {
      segment,
      edgeIds,
      sizes,
      bundleOd_mm,
      sleeving,
      recommendedSleeving,
      sleevingUndersized: sleeving !== null && bundleOd_mm > sleeving.bundleOd_mm[1]!,
      mass_g,
    }
  })
}

/* ------------------------------- mutations -------------------------------- */

export function segmentById(loom: Loom, id: string): LoomSegment | undefined {
  return loom.segments?.find((s) => s.id === id)
}

/** Fraction 0..1 along a segment, for placing a splice or a tie on the board. */
export function pointAlong(
  points: { x: number; y: number }[],
  fraction: number,
): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]!
  const clamped = Math.min(1, Math.max(0, fraction))
  let total = 0
  const spans: number[] = []
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
    spans.push(d)
    total += d
  }
  if (total === 0) return points[0]!
  let target = clamped * total
  for (let i = 0; i < spans.length; i++) {
    if (target <= spans[i]!) {
      const t = spans[i]! === 0 ? 0 : target / spans[i]!
      const a = points[i]!
      const b = points[i + 1]!
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    target -= spans[i]!
  }
  return points[points.length - 1]!
}

export { wireSizeById }
