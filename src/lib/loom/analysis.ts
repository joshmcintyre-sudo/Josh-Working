/**
 * Loom analysis: derive per-edge current from the graph, size every run, pick
 * every fuse, and validate the whole thing.
 *
 * This is the single entry point the UI and the exporters both call, so the
 * schematic panel, the formboard, the PDF and the BOM can never disagree.
 */

import {
  connectorSeriesById,
  contactDerating,
  deratedAmpacity,
  wireSizeById,
  type WireSize,
} from './data'
import { selectFuse, type FuseSelectionResult } from './fuse-selection'
import { buildPinouts, type Pinout } from './pinout'
import { cutLengthFor, loadSegments, routeWires, type RoutedWire, type SegmentLoad } from './segments'
import { sizeWire, type SizingInput, type SizingResult } from './wire-sizing'
import type { Loom, LoomEdge, LoomNode, WireFamily } from './types'

export type IssueSeverity = 'error' | 'warning' | 'info'

export type IssueCode =
  | 'dangling_edge'
  | 'duplicate_id'
  | 'no_source'
  | 'source_overloaded'
  | 'source_near_capacity'
  | 'missing_fuse'
  | 'fuse_exceeds_wire'
  | 'fuse_unselectable'
  | 'no_ground_path'
  | 'ground_undersized'
  | 'terminal_overcurrent'
  | 'over_ampacity'
  | 'over_voltage_drop'
  | 'unsized_run'
  | 'inrush_risk'
  | 'bolt_down_recommended'
  | 'mixed_gauge_circuit'
  | 'orphan_node'
  | 'interpolated_data'
  | 'unrouted_wire'
  | 'sleeving_undersized'
  | 'empty_segment'
  | 'routed_length_conflict'
  | 'circuit_drop_exceeded'
  | 'pinout_conflict'

export interface Issue {
  code: IssueCode
  severity: IssueSeverity
  message: string
  nodeId?: string
  edgeId?: string
  /** What to do about it. */
  remedy?: string
}

export interface EdgeAnalysis {
  edge: LoomEdge
  current_a: number
  /** Where the current figure came from. */
  currentSource: 'override' | 'downstream_loads' | 'ground_return'
  inrush_a: number
  effectiveLength_mm: number
  /** How many runs in series carry this one's load, including itself. */
  pathRuns?: number
  /** Where the cut length came from. */
  lengthSource: 'authored' | 'routing'
  routing: RoutedWire | undefined
  sizing: SizingResult
  fuse: FuseSelectionResult | null
  fromNode: LoomNode
  toNode: LoomNode
  color: string
}

export interface LoomAnalysis {
  loom: Loom
  edges: EdgeAnalysis[]
  byEdgeId: Record<string, EdgeAnalysis>
  totals: {
    continuousLoad_a: number
    peakInrush_a: number
    sourceCapacity_a: number
    utilisationPct: number
    wireLength_mm: number
    wireLengthBySize: { size: WireSize; length_mm: number; mass_g: number }[]
    mass_g: number
    circuitCount: number
  }
  segments: SegmentLoad[]
  /** Cavity assignments for every connector, explicit or filled in. */
  pinouts: Pinout[]
  issues: Issue[]
  errorCount: number
  warningCount: number
}

/* ---------------------------- current derivation --------------------------- */

function nodeLoadCurrent(node: LoomNode): number {
  return node.load?.continuousCurrent_a ?? 0
}

function nodeInrush(node: LoomNode): number {
  if (!node.load) return 0
  return node.load.inrushCurrent_a ?? node.load.continuousCurrent_a
}

function isGroundEdge(edge: LoomEdge, toNode: LoomNode | undefined): boolean {
  return edge.class === 'ground' || toNode?.kind === 'ground'
}

/**
 * Sum of every load reachable downstream of a node, following power flow.
 * Memoised, and cycle-safe: a node already on the stack contributes zero rather
 * than recursing forever.
 */
function makeDownstream(nodes: Map<string, LoomNode>, edges: LoomEdge[]) {
  const out = new Map<string, LoomEdge[]>()
  for (const e of edges) {
    const to = nodes.get(e.toNodeId)
    if (isGroundEdge(e, to)) continue
    const list = out.get(e.fromNodeId) ?? []
    list.push(e)
    out.set(e.fromNodeId, list)
  }
  const memo = new Map<string, number>()
  const stack = new Set<string>()
  const walk = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    stack.add(id)
    const node = nodes.get(id)
    let total = node ? nodeLoadCurrent(node) : 0
    for (const e of out.get(id) ?? []) total += walk(e.toNodeId)
    stack.delete(id)
    memo.set(id, total)
    return total
  }
  return walk
}

/** Current flowing out of a node on its return side, accumulated upstream. */
function makeGroundAccumulator(nodes: Map<string, LoomNode>, edges: LoomEdge[]) {
  const incomingGround = new Map<string, LoomEdge[]>()
  for (const e of edges) {
    if (!isGroundEdge(e, nodes.get(e.toNodeId))) continue
    const list = incomingGround.get(e.toNodeId) ?? []
    list.push(e)
    incomingGround.set(e.toNodeId, list)
  }
  const memo = new Map<string, number>()
  const stack = new Set<string>()
  const walk = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    stack.add(id)
    const node = nodes.get(id)
    let total = node ? nodeLoadCurrent(node) : 0
    for (const e of incomingGround.get(id) ?? []) total += walk(e.fromNodeId)
    stack.delete(id)
    memo.set(id, total)
    return total
  }
  return walk
}

/* --------------------------------- colour --------------------------------- */

const CLASS_COLORS: Record<string, string> = {
  power: '#d81f26',
  charging: '#e8731a',
  signal: '#1f8a3c',
  ground: '#1a1a1a',
  starter: '#d81f26',
}

/* -------------------------------- analysis -------------------------------- */

export function analyseLoom(loom: Loom): LoomAnalysis {
  const issues: Issue[] = []
  const nodes = new Map<string, LoomNode>()
  for (const n of loom.nodes) {
    if (nodes.has(n.id)) {
      issues.push({
        code: 'duplicate_id',
        severity: 'error',
        nodeId: n.id,
        message: `Duplicate node id "${n.id}".`,
      })
    }
    nodes.set(n.id, n)
  }

  const validEdges: LoomEdge[] = []
  const seenEdgeIds = new Set<string>()
  for (const e of loom.edges) {
    if (seenEdgeIds.has(e.id)) {
      issues.push({
        code: 'duplicate_id',
        severity: 'error',
        edgeId: e.id,
        message: `Duplicate edge id "${e.id}".`,
      })
    }
    seenEdgeIds.add(e.id)
    if (!nodes.has(e.fromNodeId) || !nodes.has(e.toNodeId)) {
      issues.push({
        code: 'dangling_edge',
        severity: 'error',
        edgeId: e.id,
        message: `Run ${e.circuitId} references a node that does not exist.`,
        remedy: 'Delete the run or reconnect it.',
      })
      continue
    }
    validEdges.push(e)
  }

  const routing = routeWires(loom)
  const downstream = makeDownstream(nodes, validEdges)
  const groundCurrent = makeGroundAccumulator(nodes, validEdges)

  const sources = loom.nodes.filter((n) => n.kind === 'source')
  if (sources.length === 0) {
    issues.push({
      code: 'no_source',
      severity: 'error',
      message: 'The loom has no power source node.',
      remedy: 'Add a source node for the battery or busbar feed.',
    })
  }

  const touched = new Set<string>()
  for (const e of validEdges) {
    touched.add(e.fromNodeId)
    touched.add(e.toNodeId)
  }
  // A breakout node can be joined by bundle segments alone, with wires merely
  // passing through it. That is connected, not orphaned.
  for (const seg of loom.segments ?? []) {
    touched.add(seg.fromNodeId)
    touched.add(seg.toNodeId)
  }
  for (const n of loom.nodes) {
    if (!touched.has(n.id)) {
      issues.push({
        code: 'orphan_node',
        severity: 'warning',
        nodeId: n.id,
        message: `"${n.name}" is not connected to anything.`,
      })
    }
  }

  /* ------------------------------ per-edge pass ---------------------------- */

  const analysed: EdgeAnalysis[] = []
  const sizingInputs = new Map<string, SizingInput>()

  for (const edge of validEdges) {
    const fromNode = nodes.get(edge.fromNodeId)!
    const toNode = nodes.get(edge.toNodeId)!
    const ground = isGroundEdge(edge, toNode)

    let current_a: number
    let currentSource: EdgeAnalysis['currentSource']
    if (edge.currentOverride_a !== undefined) {
      current_a = edge.currentOverride_a
      currentSource = 'override'
    } else if (ground) {
      current_a = groundCurrent(edge.fromNodeId)
      currentSource = 'ground_return'
    } else {
      current_a = downstream(edge.toNodeId)
      currentSource = 'downstream_loads'
    }

    const inrush_a = ground ? current_a : inrushDownstream(nodes, validEdges, edge.toNodeId)
    const routed = routing.get(edge.id)
    const cutLength = cutLengthFor(edge, routed)
    const lengthSource: EdgeAnalysis['lengthSource'] =
      cutLength === edge.length_mm ? 'authored' : 'routing'
    const effectiveLength_mm = cutLength + loom.settings.serviceLoop_mm
    const family: WireFamily = edge.family ?? loom.settings.defaultFamily
    const protection =
      edge.protection ?? (fromNode.kind === 'source' ? fromNode.protection : undefined)

    const sizingInput: SizingInput = {
      current_a,
      length_mm: effectiveLength_mm,
      class: edge.class,
      returnPath: edge.returnPath,
      systemVoltage_v: loom.settings.systemVoltage_v,
      basis: loom.settings.ampacityBasis,
      family,
      ambient_c: edge.ambient_c ?? loom.settings.defaultAmbient_c,
      bundleCount: edge.bundleCount ?? 1,
      minimumSizeId: loom.settings.minimumSizeId,
      gaugeOverrideId: edge.gaugeOverrideId,
      // A ground return is never fused, so the fusibility constraint does not
      // apply to it.
      requireFusible: protection !== undefined && !ground,
      fuseFamilies: protection ? [protection.familyId] : undefined,
      // If a rating is already specified, the conductor has to survive the fuse.
      minimumAmpacity_a: ground ? undefined : protection?.rating_a,
    }
    const sizing = sizeWire(sizingInput)
    sizingInputs.set(edge.id, sizingInput)

    for (const err of sizing.errors) {
      issues.push({
        code: sizing.size ? (err.includes('drop') ? 'over_voltage_drop' : 'over_ampacity') : 'unsized_run',
        severity: 'error',
        edgeId: edge.id,
        message: `${edge.circuitId}: ${err}`,
        remedy: 'Upsize the conductor, shorten the run, or split the load.',
      })
    }
    for (const w of sizing.warnings) {
      // Provenance, not a defect: the ampacity came from the fitted curve rather
      // than a published row. It belongs on the drawing, not in the defect list.
      const interpolated = w.includes('interpolated')
      issues.push({
        code: interpolated ? 'interpolated_data' : 'over_ampacity',
        severity: interpolated ? 'info' : 'warning',
        edgeId: edge.id,
        message: `${edge.circuitId}: ${w}`,
      })
    }

    /* fuse */
    let fuse: FuseSelectionResult | null = null
    if (protection && current_a > 0 && sizing.size) {
      fuse = selectFuse({
        continuousCurrent_a: current_a,
        wireAmpacity_a: sizing.deratedAmpacity_a,
        inrushCurrent_a: inrush_a > current_a ? inrush_a : undefined,
        inrushDuration_ms: peakInrushDuration(nodes, validEdges, edge.toNodeId),
        preferredFamilyId: protection.familyId,
        fixedRating_a: protection.rating_a,
      })
      // selectFuse validates a specified rating as well as choosing one, so it
      // is the single source of truth here — these just map its text to codes.
      for (const err of fuse.errors) {
        issues.push({
          code: /before the fuse does|too small to protect/.test(err)
            ? 'fuse_exceeds_wire'
            : 'fuse_unselectable',
          severity: 'error',
          edgeId: edge.id,
          message: `${edge.circuitId}: ${err}`,
          remedy: /before the fuse does|too small to protect/.test(err)
            ? `Drop the fuse to ${sizing.deratedAmpacity_a.toFixed(0)} A or below, or upsize the wire.`
            : undefined,
        })
      }
      for (const w of fuse.warnings) {
        const inrush = w.toLowerCase().includes('inrush')
        const boltDown = w.includes('blade-fuse threshold')
        issues.push({
          code: inrush ? 'inrush_risk' : boltDown ? 'bolt_down_recommended' : 'fuse_unselectable',
          severity: boltDown ? 'info' : 'warning',
          edgeId: edge.id,
          message: `${edge.circuitId}: ${w}`,
        })
      }
    }

    /* terminal current rating at either end */
    for (const node of [fromNode, toNode]) {
      if (!node.connector) continue
      const series = connectorSeriesById(node.connector.seriesId)
      if (!series) continue
      const loadedWays = validEdges.filter(
        (x) => x.fromNodeId === node.id || x.toNodeId === node.id,
      ).length
      const derate = contactDerating(Math.min(loadedWays, node.connector.ways))
      const rating = series.currentRating_a * derate
      if (current_a > rating) {
        issues.push({
          code: 'terminal_overcurrent',
          severity: 'error',
          edgeId: edge.id,
          nodeId: node.id,
          message:
            `${edge.circuitId}: ${current_a.toFixed(1)} A through "${node.name}" ` +
            `(${series.label}, ${rating.toFixed(1)} A per contact with ${loadedWays} ways loaded).`,
          remedy:
            series.id === 'deutsch-dtp'
              ? 'Above 25 A a Deutsch connector is the wrong part — terminate to a stud with ring lugs.'
              : `Move to a higher-current series, or split across contacts.`,
        })
      }
      if (sizing.size && series.wireRange_mm2.length === 2) {
        const [lo, hi] = series.wireRange_mm2 as [number, number]
        if (sizing.size.area_mm2 < lo || sizing.size.area_mm2 > hi) {
          issues.push({
            code: 'terminal_overcurrent',
            severity: 'warning',
            edgeId: edge.id,
            nodeId: node.id,
            message:
              `${edge.circuitId}: ${sizing.size.label} (${sizing.size.area_mm2} mm²) is outside the ` +
              `${lo}-${hi} mm² crimp range of ${series.label} at "${node.name}".`,
            remedy: 'A crimp outside the terminal range will not hold. Change series or size.',
          })
        }
      }
    }

    analysed.push({
      edge,
      current_a,
      currentSource,
      inrush_a,
      effectiveLength_mm,
      lengthSource,
      routing: routed,
      sizing,
      fuse,
      fromNode,
      toNode,
      color: edge.colorOverride ?? CLASS_COLORS[edge.class] ?? '#888888',
    })
  }

  /* ---------------------------- whole-loom checks --------------------------- */

  // A termination (bare, flush-cut end) sinks current the same way a load
  // does — it just has no connector, splice or lug fitted at the end of it.
  const loadNodes = loom.nodes.filter((n) => n.kind === 'load' || n.kind === 'termination')
  const continuousLoad_a = loadNodes.reduce((a, n) => a + nodeLoadCurrent(n), 0)
  const peakInrush_a = loadNodes.reduce((a, n) => a + nodeInrush(n), 0)
  const sourceCapacity_a = sources.reduce((a, n) => a + (n.source?.capacity_a ?? 0), 0)

  if (sourceCapacity_a > 0) {
    if (continuousLoad_a > sourceCapacity_a) {
      issues.push({
        code: 'source_overloaded',
        severity: 'error',
        message:
          `Total continuous load is ${continuousLoad_a.toFixed(1)} A against ` +
          `${sourceCapacity_a.toFixed(0)} A of source capacity.`,
        remedy: 'Increase alternator/battery capacity or shed load.',
      })
    } else if (continuousLoad_a > sourceCapacity_a * 0.8) {
      issues.push({
        code: 'source_near_capacity',
        severity: 'warning',
        message:
          `Total continuous load is ${((continuousLoad_a / sourceCapacity_a) * 100).toFixed(0)} % ` +
          `of source capacity — no margin for a future circuit.`,
      })
    }
  }

  // Every load needs a fused feed and a return path.
  for (const load of loadNodes) {
    if (!hasProtectionUpstream(load.id, nodes, validEdges)) {
      issues.push({
        code: 'missing_fuse',
        severity: 'error',
        nodeId: load.id,
        message: `"${load.name}" has no fuse anywhere between it and the source.`,
        remedy: 'Add protection at the source end of the feed run.',
      })
    }
    if (!hasGroundPath(load.id, nodes, validEdges)) {
      issues.push({
        code: 'no_ground_path',
        severity: 'error',
        nodeId: load.id,
        message: `"${load.name}" has no return path to a ground node.`,
        remedy: 'Add a ground run to a chassis stud or the battery negative.',
      })
    }
  }

  // A ground return must be at least as big as the feed it returns.
  const byId: Record<string, EdgeAnalysis> = {}
  for (const a of analysed) byId[a.edge.id] = a
  for (const a of analysed) {
    if (a.edge.class !== 'ground' && a.toNode.kind !== 'ground') continue
    if (!a.sizing.size) continue
    const feeds = analysed.filter(
      (f) => f.edge.toNodeId === a.edge.fromNodeId && f.edge.class !== 'ground',
    )
    for (const feed of feeds) {
      if (!feed.sizing.size) continue
      // The hard rule: the return carries the feed's current, so it must be
      // rated for it.
      if (a.sizing.deratedAmpacity_a < feed.current_a) {
        issues.push({
          code: 'ground_undersized',
          severity: 'error',
          edgeId: a.edge.id,
          message:
            `${a.edge.circuitId}: ground return is ${a.sizing.size.label} ` +
            `(${a.sizing.deratedAmpacity_a.toFixed(1)} A derated) but returns the ` +
            `${feed.current_a.toFixed(1)} A carried by feed ${feed.edge.circuitId}.`,
          remedy: `Size the ground return for ${feed.current_a.toFixed(1)} A or more.`,
        })
      } else if (a.sizing.size.area_mm2 < feed.sizing.size.area_mm2) {
        // Legal, but shop practice is to match negative to positive so the pair
        // can be cut from the same reel and nobody has to think about it.
        issues.push({
          code: 'ground_undersized',
          severity: 'warning',
          edgeId: a.edge.id,
          message:
            `${a.edge.circuitId}: ground return is ${a.sizing.size.label} against a ` +
            `${feed.sizing.size.label} feed on ${feed.edge.circuitId}. Adequate, but ` +
            `matching the feed size is the usual build convention.`,
        })
      }
    }
  }

  /* ------------------------- drop budget along a path ----------------------- */

  // Sizing each run against the full class budget lets a load at the end of
  // several runs in series see the sum of them. Rather than only reporting it,
  // upsize until the path fits.
  //
  // Greedy, not proportional: tighten the single biggest contributor on each
  // failing path, then look again. Sharing the budget out in proportion would
  // force every run to tighten, including a 350 mm battery cable where a whole
  // size up buys 0.02 %, and would fail the path if any one of them could not.
  // Each round strictly reduces the total, so it converges; the round cap is a
  // backstop, and whatever is still over afterwards gets reported below.
  if (loom.settings.allocateDropBudget !== false) {
    for (let round = 0; round < 8; round++) {
      const failing = overBudgetPaths(analysed, nodes, sources)
      if (failing.length === 0) break

      let changed = false
      for (const path of failing) {
        const candidates = path.runs
          .filter((r) => !r.edge.gaugeOverrideId && sizingInputs.has(r.edge.id))
          .sort((a, b) => b.sizing.voltageDropPct - a.sizing.voltageDropPct)
        for (const run of candidates) {
          const input = sizingInputs.get(run.edge.id)!
          // Ask for a quarter less drop than it currently makes, which lands on
          // the next size up.
          const target = (run.sizing.voltageDropPct * 0.75) / 100
          const resized = sizeWire({ ...input, dropLimit: target })
          if (resized.ok && resized.size && resized.size.area_mm2 > run.sizing.size!.area_mm2) {
            run.sizing = resized
            run.sizing.rationale +=
              ' Upsized beyond this run\u2019s own budget so the whole path stays inside it.'
            changed = true
            break
          }
        }
      }
      if (!changed) break
    }
  }

  // One circuit, one gauge. Sizing run by run can leave a short jumper thinner
  // than the feed it continues, which is legal but means two reels on the bench
  // for one circuit and the wrong one getting fitted. Lift the auto-sized runs
  // of a circuit to the largest among them.
  {
    const largest = new Map<string, WireSize>()
    for (const a of analysed) {
      if (!a.sizing.size) continue
      const current = largest.get(a.edge.circuitId)
      if (!current || a.sizing.size.area_mm2 > current.area_mm2) {
        largest.set(a.edge.circuitId, a.sizing.size)
      }
    }
    for (const a of analysed) {
      const target = largest.get(a.edge.circuitId)
      const input = sizingInputs.get(a.edge.id)
      if (!target || !input || a.edge.gaugeOverrideId || !a.sizing.size) continue
      if (a.sizing.size.area_mm2 >= target.area_mm2) continue
      const lifted = sizeWire({ ...input, gaugeOverrideId: target.id })
      if (lifted.size) {
        a.sizing = lifted
        a.sizing.limitingConstraint = 'circuit_match'
        a.sizing.rationale =
          `${target.label} — matched to the largest run in ${a.edge.circuitId}, so the circuit ` +
          `is one size on the bench. Its own constraints would allow smaller.`
      }
    }
  }

  // A circuit built from two different gauges is legal but a trap on the bench:
  // the cut list shows two reels for one circuit and someone fits the wrong one.
  //
  // Runs last, after allocation and the circuit-match pass, so it reports the
  // gauges that will actually be cut. Anything still mixed here involves a
  // manual override, which is exactly when the warning is worth having.
  const gaugesByCircuit = new Map<string, Map<string, string[]>>()
  for (const a of analysed) {
    if (!a.sizing.size) continue
    const byGauge = gaugesByCircuit.get(a.edge.circuitId) ?? new Map<string, string[]>()
    byGauge.set(a.sizing.size.label, [...(byGauge.get(a.sizing.size.label) ?? []), a.edge.id])
    gaugesByCircuit.set(a.edge.circuitId, byGauge)
  }
  for (const [circuitId, byGauge] of gaugesByCircuit) {
    if (byGauge.size < 2) continue
    issues.push({
      code: 'mixed_gauge_circuit',
      severity: 'warning',
      edgeId: [...byGauge.values()].flat()[0],
      message: `${circuitId} is built from ${[...byGauge.keys()].join(' and ')}.`,
      remedy: 'Run the whole circuit in the larger gauge unless the change is deliberate.',
    })
  }

  /* --------------------------- cumulative volt drop ------------------------- */

  // Whatever the allocation pass could not fix — usually because every run on
  // the path is manually sized — is reported rather than left silent.
  for (const path of overBudgetPaths(analysed, nodes, sources)) {
    issues.push({
      code: 'circuit_drop_exceeded',
      severity: 'error',
      nodeId: path.load.id,
      edgeId: path.runs[path.runs.length - 1]!.edge.id,
      message:
        `"${path.load.name}" sees ${path.total.toFixed(2)} % drop over ${path.runs.length} runs ` +
        `in series (${path.runs.map((p) => p.edge.circuitId).join(' \u2192 ')}), against a ` +
        `${path.limit.toFixed(1)} % budget. Each run is inside its own budget; together they ` +
        `are not.`,
      remedy: 'Upsize the longest run in the path, shorten it, or lift its gauge override.',
    })
  }

  /* ------------------------------ bundle segments --------------------------- */

  const sizeForEdge = (edgeId: string) => byId[edgeId]?.sizing.size ?? null
  const segmentLoads = loadSegments(loom, routing, sizeForEdge)

  for (const load of segmentLoads) {
    if (load.edgeIds.length === 0) {
      issues.push({
        code: 'empty_segment',
        severity: 'warning',
        message: `Bundle "${load.segment.label ?? load.segment.id}" carries no wires.`,
        remedy: 'Delete it, or connect the runs that should travel through it.',
      })
      continue
    }
    if (load.sleevingUndersized && load.sleeving) {
      issues.push({
        code: 'sleeving_undersized',
        severity: 'error',
        message:
          `Bundle "${load.segment.label ?? load.segment.id}" is ${load.bundleOd_mm.toFixed(1)} mm ` +
          `across but is sleeved in ${load.sleeving.label}, which tops out at ` +
          `${load.sleeving.bundleOd_mm[1]} mm.`,
        remedy: load.recommendedSleeving
          ? `Use ${load.recommendedSleeving.label}.`
          : 'Split the bundle or use a larger sleeve.',
      })
    }
  }

  // A wire the router could not thread through the bundle is drawn loose. On a
  // loom that has a trunk at all, that is nearly always an oversight.
  if ((loom.segments?.length ?? 0) > 0) {
    for (const a of analysed) {
      if (!a.routing?.unrouted) continue
      issues.push({
        code: 'unrouted_wire',
        severity: 'warning',
        edgeId: a.edge.id,
        message: `${a.edge.circuitId} does not travel through any bundle — it will be drawn loose.`,
        remedy: 'Add a segment between its ends, or accept it as a flying lead.',
      })
    }
  }

  // Routed length disagreeing with the authored figure means the trunk and the
  // wire schedule are telling different stories.
  for (const a of analysed) {
    const r = a.routing
    if (!r || r.unrouted || r.segmentIds.length === 0) continue
    if (a.edge.lengthFromRouting) continue
    const diff = Math.abs(r.routedLength_mm - a.edge.length_mm)
    if (a.edge.length_mm > 0 && diff / a.edge.length_mm > 0.1) {
      issues.push({
        code: 'routed_length_conflict',
        severity: 'warning',
        edgeId: a.edge.id,
        message:
          `${a.edge.circuitId} is authored at ${a.edge.length_mm} mm but its bundle path plus ` +
          `tails measures ${Math.round(r.routedLength_mm)} mm.`,
        remedy: 'Switch the run to take its length from the routing, or correct one of the two.',
      })
    }
  }

  /* ---------------------------------- totals -------------------------------- */

  const lengthBySizeId = new Map<string, number>()
  for (const a of analysed) {
    if (!a.sizing.size) continue
    lengthBySizeId.set(
      a.sizing.size.id,
      (lengthBySizeId.get(a.sizing.size.id) ?? 0) + a.effectiveLength_mm,
    )
  }
  const wireLengthBySize = [...lengthBySizeId.entries()]
    .map(([id, length_mm]) => {
      const size = wireSizeById(id)!
      return { size, length_mm, mass_g: (length_mm / 1000) * size.mass_g_per_m }
    })
    .sort((a, b) => b.size.area_mm2 - a.size.area_mm2)

  const wireLength_mm = wireLengthBySize.reduce((a, x) => a + x.length_mm, 0)
  const mass_g = wireLengthBySize.reduce((a, x) => a + x.mass_g, 0)

  const result: LoomAnalysis = {
    loom,
    edges: analysed,
    byEdgeId: byId,
    totals: {
      continuousLoad_a,
      peakInrush_a,
      sourceCapacity_a,
      utilisationPct: sourceCapacity_a > 0 ? (continuousLoad_a / sourceCapacity_a) * 100 : 0,
      wireLength_mm,
      wireLengthBySize,
      mass_g,
      circuitCount: new Set(analysed.map((a) => a.edge.circuitId)).size,
    },
    segments: segmentLoads,
    pinouts: [],
    issues,
    errorCount: 0,
    warningCount: 0,
  }

  // Pin-outs are derived from the finished analysis, then folded back in. A
  // cavity conflict is a defect like any other and belongs in the same list.
  result.pinouts = buildPinouts(result, wireReferences(analysed))
  for (const pinout of result.pinouts) {
    for (const problem of pinout.problems) {
      issues.push({
        code: 'pinout_conflict',
        severity: problem.severity,
        nodeId: pinout.node.id,
        message: `${pinout.node.name}: ${problem.message}`,
      })
    }
  }

  result.errorCount = issues.filter((i) => i.severity === 'error').length
  result.warningCount = issues.filter((i) => i.severity === 'warning').length
  return result
}

/**
 * A unique label per physical wire: the circuit id when the circuit is a single
 * run, suffixed /1, /2 when it is built from several. Two wires sharing a label
 * on the bench is how the wrong one gets fitted.
 */
export function wireReferences(edges: EdgeAnalysis[]): Map<string, string> {
  const perCircuit = new Map<string, number>()
  for (const e of edges) {
    perCircuit.set(e.edge.circuitId, (perCircuit.get(e.edge.circuitId) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const e of [...edges].sort((a, b) =>
    a.edge.circuitId.localeCompare(b.edge.circuitId, undefined, { numeric: true }),
  )) {
    const n = (seen.get(e.edge.circuitId) ?? 0) + 1
    seen.set(e.edge.circuitId, n)
    out.set(
      e.edge.id,
      (perCircuit.get(e.edge.circuitId) ?? 1) > 1 ? `${e.edge.circuitId}/${n}` : e.edge.circuitId,
    )
  }
  return out
}

/* --------------------------------- helpers -------------------------------- */

/** Source-to-load paths whose total drop is over the budget of the first run. */
function overBudgetPaths(
  analysed: EdgeAnalysis[],
  nodes: Map<string, LoomNode>,
  sources: LoomNode[],
): { load: LoomNode; runs: EdgeAnalysis[]; total: number; limit: number }[] {
  const outgoing = new Map<string, EdgeAnalysis[]>()
  for (const a of analysed) {
    if (a.edge.class === 'ground') continue
    outgoing.set(a.edge.fromNodeId, [...(outgoing.get(a.edge.fromNodeId) ?? []), a])
  }

  const out: { load: LoomNode; runs: EdgeAnalysis[]; total: number; limit: number }[] = []
  for (const source of sources) {
    const stack: { nodeId: string; path: EdgeAnalysis[] }[] = [{ nodeId: source.id, path: [] }]
    while (stack.length) {
      const step = stack.pop()!
      const node = nodes.get(step.nodeId)
      if ((node?.kind === 'load' || node?.kind === 'termination') && step.path.length > 1) {
        for (const run of step.path) {
          run.pathRuns = Math.max(run.pathRuns ?? 0, step.path.length)
        }
        const limit = step.path[0]!.sizing.dropLimitPct
        const total = step.path.reduce((t, p) => t + p.sizing.voltageDropPct, 0)
        if (total > limit) out.push({ load: node, runs: step.path, total, limit })
      }
      for (const next of outgoing.get(step.nodeId) ?? []) {
        if (step.path.some((p) => p.edge.id === next.edge.id)) continue
        stack.push({ nodeId: next.edge.toNodeId, path: [...step.path, next] })
      }
    }
  }
  return out
}

function inrushDownstream(
  nodes: Map<string, LoomNode>,
  edges: LoomEdge[],
  startId: string,
): number {
  let total = 0
  const seen = new Set<string>()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes.get(id)
    if (node) total += nodeInrush(node)
    for (const e of edges) {
      if (e.fromNodeId !== id) continue
      if (isGroundEdge(e, nodes.get(e.toNodeId))) continue
      stack.push(e.toNodeId)
    }
  }
  return total
}

function peakInrushDuration(
  nodes: Map<string, LoomNode>,
  edges: LoomEdge[],
  startId: string,
): number | undefined {
  let longest: number | undefined
  const seen = new Set<string>()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const d = nodes.get(id)?.load?.inrushDuration_ms
    if (d !== undefined && (longest === undefined || d > longest)) longest = d
    for (const e of edges) {
      if (e.fromNodeId !== id) continue
      if (isGroundEdge(e, nodes.get(e.toNodeId))) continue
      stack.push(e.toNodeId)
    }
  }
  return longest
}

/** Walk backwards toward the source looking for any protection device. */
export function hasProtectionUpstream(
  nodeId: string,
  nodes: Map<string, LoomNode>,
  edges: LoomEdge[],
): boolean {
  const seen = new Set<string>()
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes.get(id)
    if (node?.protection) return true
    for (const e of edges) {
      if (e.toNodeId !== id) continue
      if (isGroundEdge(e, nodes.get(e.toNodeId))) continue
      if (e.protection) return true
      const from = nodes.get(e.fromNodeId)
      if (from?.protection) return true
      stack.push(e.fromNodeId)
    }
  }
  return false
}

/** Is there a route from this node to a ground node? */
export function hasGroundPath(
  nodeId: string,
  nodes: Map<string, LoomNode>,
  edges: LoomEdge[],
): boolean {
  const seen = new Set<string>()
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    if (nodes.get(id)?.kind === 'ground') return true
    for (const e of edges) {
      if (e.fromNodeId === id) stack.push(e.toNodeId)
    }
  }
  return false
}

export { deratedAmpacity }
