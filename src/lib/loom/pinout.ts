/**
 * Connector pin-outs.
 *
 * A cut list and a parts list tell a builder what to make and what to buy. The
 * pin-out is what tells them where the wire actually goes. Without it someone
 * arrives at the bench with a 4-way Deutsch and four identical wires and has to
 * guess, which is how a loom gets built backwards.
 *
 * A cavity holds a circuit, not a wire. A mated cavity joins a pin on one side
 * to a socket on the other, so an inline connector has two wires in the same
 * cavity — the run arriving and the run leaving — and both are the same circuit.
 * Assignments map cavity number to circuit id, which is also how a builder
 * reads them off a drawing.
 */

import type { EdgeAnalysis, LoomAnalysis } from './analysis'
import { connectorSeriesById, contactDerating, type ConnectorSeries } from './data'
import type { LoomNode } from './types'

export interface PinAssignment {
  /** Cavity number, 1-based, as marked on the housing. */
  cavity: number
  circuitId: string | null
  /** Runs landing in this cavity: one for a terminating wire, two for inline. */
  edges: EdgeAnalysis[]
  /** True when the designer chose this cavity rather than it being filled in. */
  explicit: boolean
  /** 'through' when the circuit passes on, otherwise which way the wire runs. */
  direction: 'in' | 'out' | 'through' | null
  wireRefs: string[]
  size: string
  color: string
  current_a: number
  /** Where the circuit comes from and goes to, from this connector's view. */
  destination: string
  /** Set when this cavity carries more current than the contact is rated for. */
  overCurrent: boolean
}

export interface Pinout {
  node: LoomNode
  series: ConnectorSeries | null
  ways: number
  variant: string | null
  pins: PinAssignment[]
  /** Cavities with nothing in them. Each needs a sealing plug. */
  emptyCavities: number[]
  /** Per-contact rating after the loaded-ways derate. */
  contactRating_a: number
  problems: { severity: 'error' | 'warning'; message: string }[]
}

interface CircuitAtConnector {
  circuitId: string
  edges: EdgeAnalysis[]
}

/**
 * Circuits meeting at a connector, in a stable order: supplies before returns,
 * then by circuit id. A pin-out that reshuffles between exports is worse than
 * no pin-out at all.
 */
function circuitsAt(analysis: LoomAnalysis, nodeId: string): CircuitAtConnector[] {
  const byCircuit = new Map<string, EdgeAnalysis[]>()
  for (const e of analysis.edges) {
    if (e.edge.fromNodeId !== nodeId && e.edge.toNodeId !== nodeId) continue
    byCircuit.set(e.edge.circuitId, [...(byCircuit.get(e.edge.circuitId) ?? []), e])
  }
  return [...byCircuit.entries()]
    .map(([circuitId, edges]) => ({ circuitId, edges }))
    .sort((a, b) => {
      const aGround = a.edges.every((e) => e.edge.class === 'ground') ? 1 : 0
      const bGround = b.edges.every((e) => e.edge.class === 'ground') ? 1 : 0
      if (aGround !== bGround) return aGround - bGround
      return a.circuitId.localeCompare(b.circuitId, undefined, { numeric: true })
    })
}

export function buildPinouts(analysis: LoomAnalysis, wireRefs: Map<string, string>): Pinout[] {
  return analysis.loom.nodes
    .filter((n) => n.connector)
    .map((node) => buildPinout(analysis, node, wireRefs))
}

function buildPinout(
  analysis: LoomAnalysis,
  node: LoomNode,
  wireRefs: Map<string, string>,
): Pinout {
  const spec = node.connector!
  const series = connectorSeriesById(spec.seriesId) ?? null
  const ways = Math.max(1, spec.ways)
  const problems: Pinout['problems'] = []

  const circuits = circuitsAt(analysis, node.id)
  const byCircuitId = new Map(circuits.map((c) => [c.circuitId, c]))

  const contactRating = series
    ? series.currentRating_a * contactDerating(Math.min(circuits.length, ways))
    : Infinity

  const assigned = new Map<number, CircuitAtConnector>()
  const takenBy = new Map<string, number>()
  for (const [rawCavity, circuitId] of Object.entries(spec.cavities ?? {})) {
    const cavity = Number(rawCavity)
    if (!Number.isInteger(cavity) || cavity < 1 || cavity > ways) {
      problems.push({
        severity: 'error',
        message: `Cavity ${rawCavity} does not exist on a ${ways}-way ${series?.label ?? spec.seriesId}.`,
      })
      continue
    }
    const circuit = byCircuitId.get(circuitId)
    if (!circuit) {
      problems.push({
        severity: 'error',
        message: `Cavity ${cavity} is assigned to ${circuitId}, which does not pass through this connector.`,
      })
      continue
    }
    if (assigned.has(cavity)) {
      problems.push({ severity: 'error', message: `Cavity ${cavity} has two circuits in it.` })
      continue
    }
    const already = takenBy.get(circuitId)
    if (already !== undefined) {
      problems.push({
        severity: 'error',
        message: `${circuitId} is assigned to cavity ${already} and cavity ${cavity}.`,
      })
      continue
    }
    assigned.set(cavity, circuit)
    takenBy.set(circuitId, cavity)
  }

  // Anything unassigned drops into the lowest free cavity, in the stable order.
  for (const circuit of circuits) {
    if (takenBy.has(circuit.circuitId)) continue
    let cavity = 1
    while (cavity <= ways && assigned.has(cavity)) cavity++
    if (cavity > ways) {
      problems.push({
        severity: 'error',
        message:
          `${circuit.circuitId} has nowhere to go — ${circuits.length} circuits pass through ` +
          `here but the housing has ${ways} cavities.`,
      })
      continue
    }
    assigned.set(cavity, circuit)
    takenBy.set(circuit.circuitId, cavity)
  }

  const pins: PinAssignment[] = []
  for (let cavity = 1; cavity <= ways; cavity++) {
    const circuit = assigned.get(cavity)
    if (!circuit) {
      pins.push({
        cavity,
        circuitId: null,
        edges: [],
        explicit: false,
        direction: null,
        wireRefs: [],
        size: '',
        color: '',
        current_a: 0,
        destination: '',
        overCurrent: false,
      })
      continue
    }

    const arriving = circuit.edges.filter((e) => e.edge.toNodeId === node.id)
    const leaving = circuit.edges.filter((e) => e.edge.fromNodeId === node.id)
    const direction: PinAssignment['direction'] =
      arriving.length && leaving.length ? 'through' : arriving.length ? 'in' : 'out'
    const current = Math.max(...circuit.edges.map((e) => e.current_a))
    const over = current > contactRating
    if (over) {
      problems.push({
        severity: 'error',
        message:
          `Cavity ${cavity} (${circuit.circuitId}) carries ${current.toFixed(1)} A against a ` +
          `${contactRating.toFixed(1)} A contact rating.`,
      })
    }
    if (circuit.edges.length > 2) {
      problems.push({
        severity: 'error',
        message:
          `${circuit.circuitId} has ${circuit.edges.length} runs meeting at this connector. ` +
          `A cavity joins two — one each side.`,
      })
    }

    const from = arriving[0]?.fromNode.name
    const to = leaving[0]?.toNode.name
    pins.push({
      cavity,
      circuitId: circuit.circuitId,
      edges: circuit.edges,
      explicit: spec.cavities?.[String(cavity)] === circuit.circuitId,
      direction,
      wireRefs: circuit.edges.map((e) => wireRefs.get(e.edge.id) ?? e.edge.circuitId),
      size: circuit.edges[0]?.sizing.size?.label ?? 'UNSIZED',
      color: circuit.edges[0]?.color ?? '',
      current_a: current,
      destination: [from, to].filter(Boolean).join(' → ') || '—',
      overCurrent: over,
    })
  }

  if (!series) {
    problems.push({
      severity: 'warning',
      message: `Connector series "${spec.seriesId}" is not in the catalogue.`,
    })
  }

  return {
    node,
    series,
    ways,
    variant: spec.variant ?? null,
    pins,
    emptyCavities: pins.filter((p) => p.circuitId === null).map((p) => p.cavity),
    contactRating_a: contactRating,
    problems,
  }
}

/**
 * Turn the derived assignment into a recorded one, so it stops being a default
 * and becomes a decision.
 */
export function autoAssignCavities(
  analysis: LoomAnalysis,
  nodeId: string,
): Record<string, string> {
  const pinout = analysis.pinouts.find((p) => p.node.id === nodeId)
  if (!pinout) return {}
  const out: Record<string, string> = {}
  for (const pin of pinout.pins) if (pin.circuitId) out[String(pin.cavity)] = pin.circuitId
  return out
}
