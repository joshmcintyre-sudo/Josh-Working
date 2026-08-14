import { describe, expect, it } from 'vitest'
import { analyseLoom, type IssueCode } from './analysis'
import { DEMO_LOOM } from './demo-loom'
import type { Loom, LoomEdge, LoomNode } from './types'
import { DEFAULT_SETTINGS } from './types'

const codes = (a: ReturnType<typeof analyseLoom>): IssueCode[] => a.issues.map((i) => i.code)
const errorCodes = (a: ReturnType<typeof analyseLoom>): IssueCode[] =>
  a.issues.filter((i) => i.severity === 'error').map((i) => i.code)

/** Minimal battery -> load -> ground loom for targeted checks. */
function miniLoom(over: {
  load?: Partial<LoomNode['load']> & { continuousCurrent_a: number }
  feed?: Partial<LoomEdge>
  ground?: Partial<LoomEdge>
  sourceCapacity_a?: number
}): Loom {
  return {
    id: 'mini',
    name: 'mini',
    revision: 'A',
    settings: { ...DEFAULT_SETTINGS },
    nodes: [
      {
        id: 'bat',
        kind: 'source',
        name: 'Battery',
        location: 'x',
        position: { x: 0, y: 0 },
        source: { nominalVoltage_v: 12, capacity_a: over.sourceCapacity_a ?? 200 },
      },
      {
        id: 'load',
        kind: 'load',
        name: 'Load',
        location: 'x',
        position: { x: 1, y: 0 },
        load: { duty: 'continuous', ...(over.load ?? { continuousCurrent_a: 10 }) },
      },
      {
        id: 'gnd',
        kind: 'ground',
        name: 'Chassis',
        location: 'x',
        position: { x: 2, y: 0 },
        ground: { method: 'chassis' },
      },
    ],
    edges: [
      {
        id: 'feed',
        fromNodeId: 'bat',
        toNodeId: 'load',
        circuitId: 'C-1',
        length_mm: 1000,
        class: 'power',
        returnPath: 'modeled',
        protection: { familyId: 'ato' },
        ...over.feed,
      },
      {
        id: 'gnd-run',
        fromNodeId: 'load',
        toNodeId: 'gnd',
        circuitId: 'C-1G',
        length_mm: 1000,
        class: 'ground',
        returnPath: 'modeled',
        ...over.ground,
      },
    ],
  }
}

describe('current derivation from the graph', () => {
  it('sums every load downstream of a feed', () => {
    const a = analyseLoom(DEMO_LOOM)
    // Cab fuse block carries light bar 10 + strobe 1 + buzzer 0.5 + locking 5.
    expect(a.byEdgeId['e-bus-fb']!.current_a).toBeCloseTo(16.5, 6)
    // Busbar carries that plus both DC-DC chargers.
    expect(a.byEdgeId['e-bat-bus']!.current_a).toBeCloseTo(91.5, 6)
    // The inverter is fed straight off the battery.
    expect(a.byEdgeId['e-inv-feed']!.current_a).toBe(170)
  })

  it('accumulates ground returns upstream instead of downstream', () => {
    const a = analyseLoom(DEMO_LOOM)
    expect(a.byEdgeId['e-lightbar-gnd']!.current_a).toBe(10)
    // The cab ground strap carries every cab load's return.
    expect(a.byEdgeId['e-gndcab-chassis']!.current_a).toBeCloseTo(16.5, 6)
    expect(a.byEdgeId['e-gndcab-chassis']!.currentSource).toBe('ground_return')
  })

  it('honours a manual current override', () => {
    const loom = miniLoom({ feed: { currentOverride_a: 42 } })
    const a = analyseLoom(loom)
    expect(a.byEdgeId['feed']!.current_a).toBe(42)
    expect(a.byEdgeId['feed']!.currentSource).toBe('override')
  })

  it('does not hang on a cyclic graph', () => {
    const loom = miniLoom({})
    loom.edges.push({
      id: 'loopback',
      fromNodeId: 'load',
      toNodeId: 'bat',
      circuitId: 'C-X',
      length_mm: 100,
      class: 'power',
      returnPath: 'modeled',
    })
    expect(() => analyseLoom(loom)).not.toThrow()
  })

  it('carries inrush forward to the fuse decision', () => {
    const a = analyseLoom(DEMO_LOOM)
    expect(a.byEdgeId['e-fb-locking']!.inrush_a).toBe(40)
  })
})

describe('validation — protection', () => {
  it('flags a load with no fuse anywhere upstream', () => {
    const loom = miniLoom({ feed: { protection: undefined } })
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('missing_fuse')
  })

  it('accepts a fuse placed on the source node instead of the run', () => {
    const loom = miniLoom({ feed: { protection: undefined } })
    loom.nodes[0]!.protection = { familyId: 'ato' }
    const a = analyseLoom(loom)
    expect(errorCodes(a)).not.toContain('missing_fuse')
  })

  it('flags a fuse larger than the wire it protects', () => {
    const loom = miniLoom({
      feed: { protection: { familyId: 'ato', rating_a: 40 }, gaugeOverrideId: 'awg-18' },
    })
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('fuse_exceeds_wire')
  })

  it('warns about a fuse below 1.25x the load', () => {
    const loom = miniLoom({
      load: { continuousCurrent_a: 10 },
      feed: { protection: { familyId: 'ato', rating_a: 10 } },
    })
    const a = analyseLoom(loom)
    expect(codes(a)).toContain('fuse_unselectable')
  })

  it('warns about a long inrush on a fast-acting fuse', () => {
    const a = analyseLoom(DEMO_LOOM)
    const locking = a.issues.filter((i) => i.edgeId === 'e-fb-locking')
    expect(locking.some((i) => i.code === 'inrush_risk')).toBe(true)
  })
})

describe('validation — grounds', () => {
  it('flags a load with no return path', () => {
    const loom = miniLoom({})
    loom.edges = loom.edges.filter((e) => e.id !== 'gnd-run')
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('no_ground_path')
  })

  it('errors when the ground return cannot carry the feed current', () => {
    const loom = miniLoom({
      load: { continuousCurrent_a: 30 },
      ground: { gaugeOverrideId: 'awg-20' },
    })
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('ground_undersized')
  })

  it('only warns when the ground is adequate but thinner than the feed', () => {
    // The 30 A feed is upsized to 10 AWG for fusibility; 12 AWG still returns 30 A.
    const loom = miniLoom({
      load: { continuousCurrent_a: 30 },
      ground: { gaugeOverrideId: 'awg-12' },
    })
    const a = analyseLoom(loom)
    const g = a.issues.filter((i) => i.code === 'ground_undersized')
    expect(g.length).toBe(1)
    expect(g[0]!.severity).toBe('warning')
  })

  it('is quiet when the ground matches the feed', () => {
    const a = analyseLoom(DEMO_LOOM)
    expect(errorCodes(a)).not.toContain('ground_undersized')
  })
})

describe('validation — source and terminals', () => {
  it('errors when total load exceeds source capacity', () => {
    const loom = miniLoom({ load: { continuousCurrent_a: 100 }, sourceCapacity_a: 50 })
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('source_overloaded')
  })

  it('warns when total load is above 80 % of capacity', () => {
    const a = analyseLoom(DEMO_LOOM)
    expect(a.totals.continuousLoad_a).toBeCloseTo(261.5, 6)
    expect(a.totals.sourceCapacity_a).toBe(300)
    expect(codes(a)).toContain('source_near_capacity')
  })

  it('flags current beyond a connector contact rating', () => {
    // A DTM contact is good for 7.5 A; put 10 A through it.
    const loom = miniLoom({ load: { continuousCurrent_a: 10 } })
    loom.nodes[1]!.connector = { seriesId: 'deutsch-dtm', ways: 2 }
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('terminal_overcurrent')
  })

  it('accepts the same current on a DT contact', () => {
    const loom = miniLoom({ load: { continuousCurrent_a: 10 } })
    loom.nodes[1]!.connector = { seriesId: 'deutsch-dt', ways: 4 }
    const a = analyseLoom(loom)
    expect(errorCodes(a)).not.toContain('terminal_overcurrent')
  })

  it('warns when the chosen wire is outside the terminal crimp range', () => {
    const loom = miniLoom({ load: { continuousCurrent_a: 6 } })
    // DTM crimps 0.35-0.8 mm²; force a 2.08 mm² conductor into it.
    loom.nodes[1]!.connector = { seriesId: 'deutsch-dtm', ways: 2 }
    loom.edges[0]!.gaugeOverrideId = 'awg-14'
    const a = analyseLoom(loom)
    expect(a.issues.some((i) => i.message.includes('crimp range'))).toBe(true)
  })
})

describe('validation — graph integrity', () => {
  it('flags a run pointing at a node that does not exist', () => {
    const loom = miniLoom({})
    loom.edges[0]!.toNodeId = 'nope'
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('dangling_edge')
  })

  it('flags duplicate ids', () => {
    const loom = miniLoom({})
    loom.nodes.push({ ...loom.nodes[1]! })
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('duplicate_id')
  })

  it('flags a loom with no source', () => {
    const loom = miniLoom({})
    loom.nodes = loom.nodes.filter((n) => n.kind !== 'source')
    loom.edges = loom.edges.filter((e) => e.fromNodeId !== 'bat')
    const a = analyseLoom(loom)
    expect(errorCodes(a)).toContain('no_source')
  })

  it('warns about a node connected to nothing', () => {
    const loom = miniLoom({})
    loom.nodes.push({
      id: 'spare',
      kind: 'load',
      name: 'Spare',
      location: 'x',
      position: { x: 9, y: 9 },
      load: { continuousCurrent_a: 1, duty: 'continuous' },
    })
    const a = analyseLoom(loom)
    expect(codes(a)).toContain('orphan_node')
  })
})

describe('the demo loom', () => {
  const a = analyseLoom(DEMO_LOOM)

  it('has no errors', () => {
    const errs = a.issues.filter((i) => i.severity === 'error')
    expect(errs.map((e) => `${e.edgeId ?? e.nodeId ?? '-'}: ${e.message}`)).toEqual([])
  })

  it('sizes the inverter feed at 1/0 with a 225 A ANL', () => {
    const inv = a.byEdgeId['e-inv-feed']!
    expect(inv.sizing.size?.id).toBe('awg-1-0')
    expect(inv.sizing.limitingConstraint).toBe('fusibility')
    expect(inv.fuse?.selected?.rating_a).toBe(225)
    expect(inv.fuse?.selected?.boltDown).toBe(true)
  })

  it('is voltage-drop limited on the long unfused roof ground', () => {
    const g = a.byEdgeId['e-lightbar-gnd']!
    expect(g.sizing.limitingConstraint).toBe('voltage_drop')
    expect(g.sizing.voltageDropPct).toBeLessThanOrEqual(3)
    expect(g.sizing.ampacityDrivenSize!.area_mm2).toBeLessThan(g.sizing.size!.area_mm2)
  })

  it('upsizes the cab feed so a MIDI fuse fits under its rating', () => {
    const fb = a.byEdgeId['e-bus-fb']!
    expect(fb.sizing.limitingConstraint).toBe('fusibility')
    expect(fb.fuse?.selected?.familyId).toBe('midi')
    expect(fb.fuse!.selected!.rating_a).toBeLessThanOrEqual(fb.sizing.deratedAmpacity_a)
  })

  it('builds each circuit from a single gauge', () => {
    expect(codes(a)).not.toContain('mixed_gauge_circuit')
  })

  it('flags the vendor DC-DC fuse kit that sits below the 1.25x rule', () => {
    // Redarc's FK60 is 60 A on a 50 A charger. It protects the cable, so it is
    // a warning to be acknowledged, not an error to be auto-corrected.
    const w = a.issues.filter((i) => i.edgeId === 'e-bus-dcdc50' && i.severity === 'warning')
    expect(w.length).toBe(1)
    expect(w[0]!.message).toMatch(/below 1\.25 x/)
  })

  it('puts the buzzer and strobe on the shop minimum gauge', () => {
    expect(a.byEdgeId['e-fb-buzzer']!.sizing.size?.id).toBe('awg-20')
    expect(a.byEdgeId['e-dtm-strobe']!.sizing.size?.id).toBe('awg-20')
  })

  it('keeps every run inside its voltage-drop budget', () => {
    for (const e of a.edges) {
      expect(e.sizing.voltageDropPct, e.edge.circuitId).toBeLessThanOrEqual(e.sizing.dropLimitPct)
    }
  })

  it('keeps every run inside its derated ampacity', () => {
    for (const e of a.edges) {
      expect(e.current_a, e.edge.circuitId).toBeLessThanOrEqual(e.sizing.deratedAmpacity_a)
    }
  })

  it('never fuses above the conductor rating', () => {
    for (const e of a.edges) {
      if (!e.fuse?.selected) continue
      expect(e.fuse.selected.rating_a, e.edge.circuitId).toBeLessThanOrEqual(
        e.sizing.deratedAmpacity_a,
      )
    }
  })

  it('totals wire length and mass for the BOM', () => {
    const summed = DEMO_LOOM.edges.reduce((t, e) => t + e.length_mm, 0)
    expect(a.totals.wireLength_mm).toBe(summed)
    expect(a.totals.mass_g).toBeGreaterThan(0)
    expect(a.totals.wireLengthBySize.length).toBeGreaterThan(1)
  })

  it('applies the service loop allowance to every run', () => {
    const withLoop = analyseLoom({
      ...DEMO_LOOM,
      settings: { ...DEMO_LOOM.settings, serviceLoop_mm: 100 },
    })
    expect(withLoop.totals.wireLength_mm).toBe(
      a.totals.wireLength_mm + 100 * DEMO_LOOM.edges.length,
    )
  })
})
