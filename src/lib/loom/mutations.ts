/**
 * Structural edits to a loom.
 *
 * Pure functions returning a new loom, so they can be tested without a browser
 * and undone by the editor's history without special cases. Nothing here
 * mutates its input.
 */

import { pointAlong, routeWires } from './segments'
import type { Loom, LoomEdge, LoomNode, LoomSegment, WireClass } from './types'

function freeId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let n = 1
  while (used.has(`${prefix}-${n}`)) n++
  return `${prefix}-${n}`
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

/* ----------------------------- splice a wire ------------------------------ */

export interface InsertSpliceResult {
  loom: Loom
  spliceId: string
  /** The two runs the original was split into, source end first. */
  edgeIds: [string, string]
}

/**
 * Put a splice into the middle of a run.
 *
 * The run is cut at `distance_mm` from its source end and a splice node is
 * dropped there, positioned proportionally along the drawn path so it lands on
 * the line rather than beside it. The two halves keep the original circuit id —
 * the cut list gives them distinct wire references.
 *
 * Total length is preserved exactly, so the loom does not silently grow or
 * shrink when someone adds a branch point.
 */
export function insertSpliceInRun(
  loom: Loom,
  edgeId: string,
  distance_mm: number,
): InsertSpliceResult {
  const edge = loom.edges.find((e) => e.id === edgeId)
  if (!edge) throw new Error(`No run with id "${edgeId}".`)
  const from = loom.nodes.find((n) => n.id === edge.fromNodeId)
  const to = loom.nodes.find((n) => n.id === edge.toNodeId)
  if (!from || !to) throw new Error(`Run "${edgeId}" is not connected at both ends.`)

  const clamped = Math.min(Math.max(distance_mm, 1), Math.max(1, edge.length_mm - 1))
  const t = edge.length_mm > 0 ? clamped / edge.length_mm : 0.5

  const spliceId = freeId('splice', loom.nodes.map((n) => n.id))
  const splice: LoomNode = {
    id: spliceId,
    kind: 'splice',
    name: `${edge.circuitId} splice`,
    location: from.location || to.location,
    position: {
      x: lerp(from.position.x, to.position.x, t),
      y: lerp(from.position.y, to.position.y, t),
    },
    formboardPosition:
      from.formboardPosition && to.formboardPosition
        ? pointAlong(
            edge.routing?.length
              ? [from.formboardPosition, ...edge.routing, to.formboardPosition]
              : [from.formboardPosition, to.formboardPosition],
            t,
          )
        : undefined,
    splice: { method: 'crimp' },
  }
  if (splice.formboardPosition) {
    splice.formboardPosition = {
      x: Math.round(splice.formboardPosition.x),
      y: Math.round(splice.formboardPosition.y),
    }
  }

  // If the wire travels inside a bundle, the splice is physically inside that
  // bundle too. Break the bundle at the same point so the splice lands on the
  // trunk on the board — which is where a builder needs to see it — instead of
  // floating beside it with both halves unrouted.
  const bundlePath = routeWires(loom).get(edgeId)
  let working: Loom = loom
  if (bundlePath && !bundlePath.unrouted && bundlePath.segmentIds.length > 0) {
    const target = locateAlongBundle(loom, bundlePath.segmentIds, clamped, edge)
    if (target) {
      const split = splitSegmentAtNode(loom, target.segmentId, target.offset_mm, splice)
      working = split.loom
      // The split placed the splice on the bundle; use that position.
      const placed = working.nodes.find((n) => n.id === spliceId)
      if (placed?.formboardPosition) splice.formboardPosition = placed.formboardPosition
    }
  }
  if (working === loom) {
    working = { ...loom, nodes: [...loom.nodes, splice] }
  }

  const takenEdgeIds = new Set(working.edges.map((e) => e.id))
  const firstId = freeId('run', takenEdgeIds)
  takenEdgeIds.add(firstId)
  const secondId = freeId('run', takenEdgeIds)

  // Protection lives at the source end, so it stays with the first half. The
  // second half inherits everything else.
  const { id: _oldId, ...shared } = edge
  const first: LoomEdge = {
    ...shared,
    id: firstId,
    toNodeId: spliceId,
    length_mm: clamped,
    routing: undefined,
  }
  const second: LoomEdge = {
    ...shared,
    id: secondId,
    fromNodeId: spliceId,
    length_mm: edge.length_mm - clamped,
    protection: undefined,
    routing: undefined,
  }

  const index = working.edges.findIndex((e) => e.id === edgeId)
  const edges = [...working.edges]
  edges.splice(index, 1, first, second)

  return {
    loom: { ...working, edges },
    spliceId,
    edgeIds: [firstId, secondId],
  }
}

/**
 * Which bundle segment a given distance along a wire falls in, and how far into
 * that segment it lands. Tails at the source end are wire outside the bundle,
 * so they are consumed before the first segment starts.
 */
function locateAlongBundle(
  loom: Loom,
  segmentIds: string[],
  distance_mm: number,
  edge: LoomEdge,
): { segmentId: string; offset_mm: number } | null {
  const tail = edge.tails_mm?.from ?? loom.settings.defaultTail_mm ?? 0
  let remaining = distance_mm - tail
  if (remaining <= 0) return null
  for (const id of segmentIds) {
    const segment = loom.segments?.find((s) => s.id === id)
    if (!segment) return null
    if (remaining < segment.length_mm) {
      return { segmentId: id, offset_mm: Math.max(1, Math.round(remaining)) }
    }
    remaining -= segment.length_mm
  }
  return null
}

/** splitSegment, but breaking at a node the caller has already built. */
function splitSegmentAtNode(
  loom: Loom,
  segmentId: string,
  distance_mm: number,
  node: LoomNode,
): { loom: Loom } {
  const segment = loom.segments!.find((s) => s.id === segmentId)!
  const from = loom.nodes.find((n) => n.id === segment.fromNodeId)
  const to = loom.nodes.find((n) => n.id === segment.toNodeId)
  const clamped = Math.min(Math.max(distance_mm, 1), Math.max(1, segment.length_mm - 1))
  const t = segment.length_mm > 0 ? clamped / segment.length_mm : 0.5

  const placed: LoomNode = {
    ...node,
    formboardPosition:
      from?.formboardPosition && to?.formboardPosition
        ? (() => {
            const p = pointAlong(
              segment.routing?.length
                ? [from.formboardPosition!, ...segment.routing, to.formboardPosition!]
                : [from.formboardPosition!, to.formboardPosition!],
              t,
            )
            return { x: Math.round(p.x), y: Math.round(p.y) }
          })()
        : node.formboardPosition,
    position:
      from && to
        ? { x: lerp(from.position.x, to.position.x, t), y: lerp(from.position.y, to.position.y, t) }
        : node.position,
  }

  const taken = new Set((loom.segments ?? []).map((s) => s.id))
  const firstId = freeId('seg', taken)
  taken.add(firstId)
  const secondId = freeId('seg', taken)

  const segments = [...(loom.segments ?? [])]
  const index = segments.findIndex((s) => s.id === segmentId)
  segments.splice(
    index,
    1,
    { ...segment, id: firstId, toNodeId: placed.id, length_mm: clamped, routing: undefined },
    {
      ...segment,
      id: secondId,
      fromNodeId: placed.id,
      length_mm: segment.length_mm - clamped,
      routing: undefined,
    },
  )

  const edges = loom.edges.map((e) =>
    e.segmentIds?.includes(segmentId)
      ? {
          ...e,
          segmentIds: e.segmentIds.flatMap((id) => (id === segmentId ? [firstId, secondId] : [id])),
        }
      : e,
  )

  return { loom: { ...loom, nodes: [...loom.nodes, placed], edges, segments } }
}

/* ---------------------------- splice a segment ---------------------------- */

export interface SplitSegmentResult {
  loom: Loom
  nodeId: string
  segmentIds: [string, string]
}

/**
 * Break a bundle segment at a distance along it, dropping a node there.
 *
 * This is how a branch gets added to an existing trunk: split the trunk, then
 * run new segments off the new node. Wires that named this segment explicitly
 * have their path rewritten to the two halves; wires routed automatically are
 * re-derived and need no change.
 */
export function splitSegment(
  loom: Loom,
  segmentId: string,
  distance_mm: number,
  options: { kind?: 'splice' | 'connector'; name?: string } = {},
): SplitSegmentResult {
  const segment = loom.segments?.find((s) => s.id === segmentId)
  if (!segment) throw new Error(`No segment with id "${segmentId}".`)
  const from = loom.nodes.find((n) => n.id === segment.fromNodeId)
  const to = loom.nodes.find((n) => n.id === segment.toNodeId)
  if (!from || !to) throw new Error(`Segment "${segmentId}" is not connected at both ends.`)

  const clamped = Math.min(Math.max(distance_mm, 1), Math.max(1, segment.length_mm - 1))
  const t = segment.length_mm > 0 ? clamped / segment.length_mm : 0.5

  const nodeId = freeId('branch', loom.nodes.map((n) => n.id))
  const node: LoomNode = {
    id: nodeId,
    kind: options.kind ?? 'splice',
    name: options.name ?? `${segment.label ?? segmentId} breakout`,
    location: from.location || to.location,
    position: {
      x: lerp(from.position.x, to.position.x, t),
      y: lerp(from.position.y, to.position.y, t),
    },
    formboardPosition:
      from.formboardPosition && to.formboardPosition
        ? (() => {
            const p = pointAlong(
              segment.routing?.length
                ? [from.formboardPosition!, ...segment.routing, to.formboardPosition!]
                : [from.formboardPosition!, to.formboardPosition!],
              t,
            )
            return { x: Math.round(p.x), y: Math.round(p.y) }
          })()
        : undefined,
    splice: options.kind === 'connector' ? undefined : { method: 'crimp' },
    connector: options.kind === 'connector' ? { seriesId: 'deutsch-dt', ways: 2 } : undefined,
  }

  const taken = new Set((loom.segments ?? []).map((s) => s.id))
  const firstId = freeId('seg', taken)
  taken.add(firstId)
  const secondId = freeId('seg', taken)

  const first: LoomSegment = {
    ...segment,
    id: firstId,
    toNodeId: nodeId,
    length_mm: clamped,
    routing: undefined,
  }
  const second: LoomSegment = {
    ...segment,
    id: secondId,
    fromNodeId: nodeId,
    length_mm: segment.length_mm - clamped,
    routing: undefined,
  }

  const segments = [...(loom.segments ?? [])]
  const index = segments.findIndex((s) => s.id === segmentId)
  segments.splice(index, 1, first, second)

  // Rewrite any wire that named this segment explicitly.
  const edges = loom.edges.map((e) => {
    if (!e.segmentIds?.includes(segmentId)) return e
    return {
      ...e,
      segmentIds: e.segmentIds.flatMap((id) => (id === segmentId ? [firstId, secondId] : [id])),
    }
  })

  return {
    loom: { ...loom, nodes: [...loom.nodes, node], edges, segments },
    nodeId,
    segmentIds: [firstId, secondId],
  }
}

/* -------------------------------- duplicate ------------------------------- */

/**
 * Copy a node and everything on it — load figures, connector, protection — but
 * not its connections. Offset so it does not land exactly on the original.
 */
export function duplicateNode(
  loom: Loom,
  nodeId: string,
  offset = { x: 40, y: 40 },
): { loom: Loom; nodeId: string } {
  const source = loom.nodes.find((n) => n.id === nodeId)
  if (!source) throw new Error(`No node with id "${nodeId}".`)

  const newId = freeId(source.kind, loom.nodes.map((n) => n.id))
  const copy: LoomNode = structuredClone({
    ...source,
    id: newId,
    name: nextCopyName(source.name, loom.nodes.map((n) => n.name)),
    position: { x: source.position.x + offset.x, y: source.position.y + offset.y },
    formboardPosition: source.formboardPosition
      ? { x: source.formboardPosition.x + 120, y: source.formboardPosition.y + 120 }
      : undefined,
  })

  return { loom: { ...loom, nodes: [...loom.nodes, copy] }, nodeId: newId }
}

/** "Work lamp" -> "Work lamp 2" -> "Work lamp 3". */
export function nextCopyName(name: string, existing: string[]): string {
  const base = name.replace(/\s+\d+$/, '')
  const taken = new Set(existing)
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Copy a run, including its sizing overrides, between the same two nodes. */
export function duplicateEdge(loom: Loom, edgeId: string): { loom: Loom; edgeId: string } {
  const source = loom.edges.find((e) => e.id === edgeId)
  if (!source) throw new Error(`No run with id "${edgeId}".`)
  const newId = freeId('run', loom.edges.map((e) => e.id))
  const copy: LoomEdge = structuredClone({ ...source, id: newId })
  return { loom: { ...loom, edges: [...loom.edges, copy] }, edgeId: newId }
}

export interface DuplicateBranchResult {
  loom: Loom
  /** Copy of `rootNodeId` — the device, or its connector, that was duplicated. */
  rootNodeId: string
  nodeIds: string[]
  edgeIds: string[]
  segmentIds: string[]
  /** Where the duplicate attaches to the rest of the loom. */
  branchNodeId: string
}

/**
 * Copy a whole device branch — everything hanging off `rootNodeId` away from
 * the rest of the loom, its connector included — and reattach the copy at a
 * new point on an existing trunk, or an existing splice/connector already
 * there.
 *
 * This is the one-shot version of "wire up another one of these, off the
 * bundle at 750mm": most looms here are duplicated from an existing hand-built
 * one, not drawn from scratch, so copying a device node in isolation and
 * rewiring it by hand is the wrong grain. Pick the device, or the connector it
 * plugs into, as `rootNodeId` — everything beyond it comes with it.
 *
 * Runs that connect the root back to the rest of the loom are not copied —
 * they are rebuilt from the new attachment point instead, at the same length
 * and protection and on the same circuit id, so the duplicate reads as
 * another run of the same circuit off the same splice, the way the user's own
 * "splice feeds strobe #2" example works, rather than a new circuit that
 * happens to look the same.
 */
export function duplicateBranch(
  loom: Loom,
  rootNodeId: string,
  target: { segmentId: string; distance_mm: number } | { nodeId: string },
  offset = { x: 40, y: 40 },
): DuplicateBranchResult {
  const root = loom.nodes.find((n) => n.id === rootNodeId)
  if (!root) throw new Error(`No node with id "${rootNodeId}".`)

  // A run touching root is "upstream" — part of the rest of the loom, not the
  // branch — if current flows into root on it (power arriving) or out of root
  // on it (a ground return leaving, which accumulates back toward source).
  const touching = loom.edges.filter((e) => e.fromNodeId === rootNodeId || e.toNodeId === rootNodeId)
  const upstream = touching.filter((e) =>
    e.class === 'ground' ? e.fromNodeId === rootNodeId : e.toNodeId === rootNodeId,
  )
  if (upstream.length === 0) {
    throw new Error(`"${root.name}" has no run connecting it to the rest of the loom to duplicate from.`)
  }
  const upstreamIds = new Set(upstream.map((e) => e.id))

  // Everything reachable from root without crossing an upstream run is the
  // branch: root itself, its device(s), and every run between them.
  const subtreeNodeIds = new Set<string>([rootNodeId])
  const subtreeEdgeIds = new Set<string>()
  const queue = [rootNodeId]
  while (queue.length) {
    const id = queue.shift()!
    for (const e of loom.edges) {
      if (upstreamIds.has(e.id) || subtreeEdgeIds.has(e.id)) continue
      if (e.fromNodeId !== id && e.toNodeId !== id) continue
      subtreeEdgeIds.add(e.id)
      const other = e.fromNodeId === id ? e.toNodeId : e.fromNodeId
      if (!subtreeNodeIds.has(other)) {
        subtreeNodeIds.add(other)
        queue.push(other)
      }
    }
  }
  const subtreeEdges = loom.edges.filter((e) => subtreeEdgeIds.has(e.id))

  const segments = loom.segments ?? []
  const internalSegments = segments.filter(
    (s) => subtreeNodeIds.has(s.fromNodeId) && subtreeNodeIds.has(s.toNodeId),
  )
  const connectingSegments = segments.filter(
    (s) => subtreeNodeIds.has(s.fromNodeId) !== subtreeNodeIds.has(s.toNodeId),
  )

  /* ---- clone the branch's own nodes ---- */

  const takenNodeIds = new Set(loom.nodes.map((n) => n.id))
  const takenNames = loom.nodes.map((n) => n.name)
  const idMap = new Map<string, string>()
  const clonedNodes: LoomNode[] = []
  for (const nodeId of subtreeNodeIds) {
    const original = loom.nodes.find((n) => n.id === nodeId)!
    const newId = freeId(original.kind, takenNodeIds)
    takenNodeIds.add(newId)
    idMap.set(nodeId, newId)
    const name = nextCopyName(original.name, takenNames)
    takenNames.push(name)
    clonedNodes.push(
      structuredClone({
        ...original,
        id: newId,
        name,
        position: { x: original.position.x + offset.x, y: original.position.y + offset.y },
        formboardPosition: original.formboardPosition
          ? { x: original.formboardPosition.x + 120, y: original.formboardPosition.y + 120 }
          : undefined,
      }),
    )
  }

  /* ---- clone the branch's own segments ---- */

  const takenSegIds = new Set(segments.map((s) => s.id))
  const clonedInternalSegments: LoomSegment[] = internalSegments.map((s) => {
    const newId = freeId('seg', takenSegIds)
    takenSegIds.add(newId)
    return {
      ...structuredClone(s),
      id: newId,
      fromNodeId: idMap.get(s.fromNodeId)!,
      toNodeId: idMap.get(s.toNodeId)!,
    }
  })

  let working: Loom = {
    ...loom,
    nodes: [...loom.nodes, ...clonedNodes],
    segments: [...segments, ...clonedInternalSegments],
  }

  /* ---- the attachment point: an existing node, or a fresh breakout ---- */

  let branchNodeId: string
  if ('nodeId' in target) {
    branchNodeId = target.nodeId
  } else {
    const split = splitSegment(working, target.segmentId, target.distance_mm, { kind: 'splice' })
    working = split.loom
    branchNodeId = split.nodeId
  }

  /* ---- new segments carrying the branch's own pigtail from that point ---- */

  const takenSegIdsForNew = new Set((working.segments ?? []).map((s) => s.id))
  const nextSegId = () => {
    const id = freeId('seg', takenSegIdsForNew)
    takenSegIdsForNew.add(id)
    return id
  }
  const newSegments: LoomSegment[] = connectingSegments.map((s) => {
    const rootSideOld = subtreeNodeIds.has(s.fromNodeId) ? s.fromNodeId : s.toNodeId
    return {
      ...structuredClone(s),
      id: nextSegId(),
      fromNodeId: branchNodeId,
      toNodeId: idMap.get(rootSideOld)!,
    }
  })
  working = { ...working, segments: [...(working.segments ?? []), ...newSegments] }

  /* ---- clone the branch's own wires, and rebuild the runs that fed it ---- */

  const takenEdgeIds = new Set(working.edges.map((e) => e.id))
  const nextEdgeId = () => {
    const id = freeId('run', takenEdgeIds)
    takenEdgeIds.add(id)
    return id
  }
  const nodeById = new Map(loom.nodes.map((n) => [n.id, n]))

  const clonedEdges: LoomEdge[] = subtreeEdges.map((e) => ({
    ...structuredClone(e),
    id: nextEdgeId(),
    fromNodeId: idMap.get(e.fromNodeId)!,
    toNodeId: idMap.get(e.toNodeId)!,
    segmentIds: undefined,
    routing: undefined,
  }))

  // Ground is usually a shared bus reached independently of wherever the power
  // trunk is spliced — a light bar and a strobe on the same fuse block splice
  // still return to the one chassis stud, not to each other. So only power
  // (or signal/charging/starter) upstream runs are rebuilt at the new
  // attachment point; a ground upstream run is rebuilt to the exact same far
  // node as the original, same as duplicating that one run on its own would.
  const newUpstreamEdges: LoomEdge[] = upstream.map((e) => {
    const rootSideOld = subtreeNodeIds.has(e.fromNodeId) ? e.fromNodeId : e.toNodeId
    const farNodeId = e.fromNodeId === rootSideOld ? e.toNodeId : e.fromNodeId
    const farNode = nodeById.get(farNodeId)
    const ground = e.class === 'ground'
    // A run fed straight off a source node with no protection of its own
    // inherits the source's — carry that forward explicitly, since a power
    // run's new "from" end is the splice, not the source, and would otherwise
    // silently lose it.
    const inheritedProtection =
      !ground && (e.protection ?? (farNode?.kind === 'source' ? farNode.protection : undefined))
    return {
      ...structuredClone(e),
      id: nextEdgeId(),
      fromNodeId: ground ? idMap.get(rootSideOld)! : branchNodeId,
      toNodeId: ground ? farNodeId : idMap.get(rootSideOld)!,
      protection: inheritedProtection || undefined,
      segmentIds: undefined,
      routing: undefined,
    }
  })

  working = { ...working, edges: [...working.edges, ...clonedEdges, ...newUpstreamEdges] }

  return {
    loom: working,
    rootNodeId: idMap.get(rootNodeId)!,
    nodeIds: clonedNodes.map((n) => n.id),
    edgeIds: [...clonedEdges, ...newUpstreamEdges].map((e) => e.id),
    segmentIds: [...clonedInternalSegments, ...newSegments].map((s) => s.id),
    branchNodeId,
  }
}

/* -------------------------------- deletion -------------------------------- */

export interface DeletionImpact {
  edgeIds: string[]
  segmentIds: string[]
  /** Wires that will lose their routing because a segment went with it. */
  reroutedEdgeIds: string[]
}

/** What deleting this node would take with it. Shown before confirming. */
export function nodeDeletionImpact(loom: Loom, nodeId: string): DeletionImpact {
  const edgeIds = loom.edges
    .filter((e) => e.fromNodeId === nodeId || e.toNodeId === nodeId)
    .map((e) => e.id)
  const segmentIds = (loom.segments ?? [])
    .filter((s) => s.fromNodeId === nodeId || s.toNodeId === nodeId)
    .map((s) => s.id)
  const reroutedEdgeIds = loom.edges
    .filter((e) => e.segmentIds?.some((id) => segmentIds.includes(id)))
    .map((e) => e.id)
  return { edgeIds, segmentIds, reroutedEdgeIds }
}

export function segmentDeletionImpact(loom: Loom, segmentId: string): DeletionImpact {
  const reroutedEdgeIds = loom.edges
    .filter((e) => e.segmentIds?.includes(segmentId))
    .map((e) => e.id)
  return { edgeIds: [], segmentIds: [segmentId], reroutedEdgeIds }
}

export function removeNode(loom: Loom, nodeId: string): Loom {
  return {
    ...loom,
    nodes: loom.nodes.filter((n) => n.id !== nodeId),
    edges: loom.edges.filter((e) => e.fromNodeId !== nodeId && e.toNodeId !== nodeId),
    segments: (loom.segments ?? []).filter(
      (s) => s.fromNodeId !== nodeId && s.toNodeId !== nodeId,
    ),
  }
}

export function removeSegment(loom: Loom, segmentId: string): Loom {
  return {
    ...loom,
    segments: (loom.segments ?? []).filter((s) => s.id !== segmentId),
    // A wire that named the deleted segment falls back to automatic routing
    // rather than keeping a dangling reference.
    edges: loom.edges.map((e) =>
      e.segmentIds?.includes(segmentId)
        ? { ...e, segmentIds: e.segmentIds.filter((id) => id !== segmentId) }
        : e,
    ),
  }
}

/* ------------------------------- new objects ------------------------------ */

/**
 * The class a new run should take.
 *
 * A run into a ground node is obviously a return. So is a run into a splice
 * that only ever collects returns — that is a ground splice, and getting this
 * right is what stops half the negatives on a loom being drawn red.
 */
export function inferWireClass(loom: Loom, fromNodeId: string, toNodeId: string): WireClass {
  const to = loom.nodes.find((n) => n.id === toNodeId)
  if (!to) return 'power'
  if (to.kind === 'ground') return 'ground'
  if (to.kind === 'splice') {
    const touching = loom.edges.filter((e) => e.fromNodeId === toNodeId || e.toNodeId === toNodeId)
    const reachesGround = hasGroundDownstream(loom, toNodeId, new Set([fromNodeId]))
    if (touching.length > 0 && touching.every((e) => e.class === 'ground') && reachesGround) {
      return 'ground'
    }
  }
  const from = loom.nodes.find((n) => n.id === fromNodeId)
  if (
    (from?.kind === 'load' || from?.kind === 'termination') &&
    to.kind !== 'load' &&
    to.kind !== 'termination'
  ) {
    return 'ground'
  }
  return 'power'
}

function hasGroundDownstream(loom: Loom, startId: string, seen: Set<string>): boolean {
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    if (loom.nodes.find((n) => n.id === id)?.kind === 'ground') return true
    for (const e of loom.edges) {
      if (e.fromNodeId === id) stack.push(e.toNodeId)
      else if (e.toNodeId === id) stack.push(e.fromNodeId)
    }
  }
  return false
}

export function addSegment(
  loom: Loom,
  fromNodeId: string,
  toNodeId: string,
  length_mm: number,
): { loom: Loom; segmentId: string } {
  const id = freeId('seg', (loom.segments ?? []).map((s) => s.id))
  const segment: LoomSegment = { id, fromNodeId, toNodeId, length_mm }
  return { loom: { ...loom, segments: [...(loom.segments ?? []), segment] }, segmentId: id }
}
