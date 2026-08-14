import { describe, expect, it } from 'vitest'
import { analyseLoom, wireReferences } from './analysis'
import { DEMO_LOOM } from './demo-loom'
import { autoAssignCavities, buildPinouts } from './pinout'
import type { Loom } from './types'

const analysis = analyseLoom(DEMO_LOOM)

describe('pin-outs on the demo', () => {
  it('produces one per connector node', () => {
    expect(analysis.pinouts.map((p) => p.node.id).sort()).toEqual(
      ['dt2_lightbar', 'dtm2_strobe'].sort(),
    )
  })

  it('honours the cavity assignments the designer made', () => {
    const dt = analysis.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.pins[0]!.circuitId).toBe('C-201')
    expect(dt.pins[0]!.explicit).toBe(true)
    expect(dt.pins[1]!.circuitId).toBe('C-201G')
  })

  it('puts both wires of an inline circuit in the same cavity', () => {
    // A mated cavity joins a pin to a socket: one run in, one run out.
    const dt = analysis.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.pins[0]!.edges.map((e) => e.edge.id).sort()).toEqual(
      ['e-dt-lightbar', 'e-fb-lightbar'].sort(),
    )
    expect(dt.pins[0]!.direction).toBe('through')
    expect(dt.pins[0]!.wireRefs).toHaveLength(2)
  })

  it('names what the circuit runs between', () => {
    const dt = analysis.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.pins[0]!.destination).toContain('12-way accessory fuse block')
    expect(dt.pins[0]!.destination).toContain('LED light bar')
  })

  it('carries the derated per-contact rating', () => {
    const dt = analysis.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    // A DT contact is 13 A, derated for two loaded ways.
    expect(dt.contactRating_a).toBeLessThan(13)
    expect(dt.contactRating_a).toBeGreaterThan(10)
  })

  it('raises no pin-out problems on a loom that is assigned properly', () => {
    expect(analysis.issues.some((i) => i.code === 'pinout_conflict')).toBe(false)
  })
})

describe('filling in what the designer left out', () => {
  const unassigned: Loom = structuredClone(DEMO_LOOM)
  for (const n of unassigned.nodes) if (n.connector) n.connector.cavities = undefined
  const a = analyseLoom(unassigned)

  it('still produces a full pin-out', () => {
    const dt = a.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.pins.filter((p) => p.circuitId).length).toBe(2)
  })

  it('marks the filled-in rows as not chosen', () => {
    const dt = a.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    for (const pin of dt.pins) if (pin.circuitId) expect(pin.explicit).toBe(false)
  })

  it('puts supplies before returns so the order is stable', () => {
    const dt = a.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.pins[0]!.circuitId).toBe('C-201')
    expect(dt.pins[1]!.circuitId).toBe('C-201G')
  })

  it('gives the same answer twice', () => {
    const first = analyseLoom(unassigned).pinouts[0]!.pins.map((p) => p.circuitId)
    const second = analyseLoom(unassigned).pinouts[0]!.pins.map((p) => p.circuitId)
    expect(first).toEqual(second)
  })

  it('turns the derived assignment into a real one on request', () => {
    const assigned = autoAssignCavities(a, 'dt2_lightbar')
    expect(Object.keys(assigned)).toEqual(['1', '2'])
    expect(Object.values(assigned)).toContain('C-201')
  })
})

describe('pin-out problems', () => {
  const withConnector = (mutate: (loom: Loom) => void): Loom => {
    const loom = structuredClone(DEMO_LOOM)
    mutate(loom)
    return loom
  }

  it('flags two wires assigned to the same cavity', () => {
    const loom = withConnector((l) => {
      l.nodes.find((n) => n.id === 'dt2_lightbar')!.connector!.cavities = {
        '1': 'C-201',
        '2': 'C-201',
      }
    })
    const problems = analyseLoom(loom).issues.filter((i) => i.code === 'pinout_conflict')
    expect(problems.some((p) => /two cavities|cavity 1 and cavity 2/i.test(p.message))).toBe(true)
  })

  it('flags a cavity that does not exist on the housing', () => {
    const loom = withConnector((l) => {
      l.nodes.find((n) => n.id === 'dt2_lightbar')!.connector!.cavities = { '9': 'C-201' }
    })
    expect(
      analyseLoom(loom).issues.some((i) => i.code === 'pinout_conflict' && /does not exist/.test(i.message)),
    ).toBe(true)
  })

  it('flags a cavity assigned to a wire that does not land here', () => {
    const loom = withConnector((l) => {
      l.nodes.find((n) => n.id === 'dt2_lightbar')!.connector!.cavities = { '1': 'C-203' }
    })
    expect(
      analyseLoom(loom).issues.some(
        (i) => i.code === 'pinout_conflict' && /does not pass through/.test(i.message),
      ),
    ).toBe(true)
  })

  it('flags more wires than the housing has cavities', () => {
    const loom = withConnector((l) => {
      const c = l.nodes.find((n) => n.id === 'dt2_lightbar')!.connector!
      c.ways = 1
      c.cavities = undefined
    })
    expect(
      analyseLoom(loom).issues.some(
        (i) => i.code === 'pinout_conflict' && /nowhere to go/.test(i.message),
      ),
    ).toBe(true)
  })

  it('flags a cavity carrying more than its contact is rated for', () => {
    const loom = withConnector((l) => {
      // Put the light bar's 10 A through a DTM, rated 7.5 A a contact.
      l.nodes.find((n) => n.id === 'dt2_lightbar')!.connector!.seriesId = 'deutsch-dtm'
    })
    expect(
      analyseLoom(loom).issues.some(
        (i) => i.code === 'pinout_conflict' && /contact rating/.test(i.message),
      ),
    ).toBe(true)
  })

  it('lists empty cavities so they get sealing plugs', () => {
    const loom = withConnector((l) => {
      l.nodes.find((n) => n.id === 'dt2_lightbar')!.connector!.ways = 6
    })
    const dt = analyseLoom(loom).pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.emptyCavities).toEqual([3, 4, 5, 6])
  })
})

describe('wire references', () => {
  it('are unique and shared between the cut list and the pin-out', () => {
    const refs = wireReferences(analysis.edges)
    expect(new Set(refs.values()).size).toBe(refs.size)
    const dt = analysis.pinouts.find((p) => p.node.id === 'dt2_lightbar')!
    expect(dt.pins[0]!.wireRefs).toContain(refs.get('e-fb-lightbar'))
  })
})

describe('buildPinouts directly', () => {
  it('returns nothing for a loom with no connectors', () => {
    const bare: Loom = structuredClone(DEMO_LOOM)
    for (const n of bare.nodes) n.connector = undefined
    const a = analyseLoom(bare)
    expect(buildPinouts(a, wireReferences(a.edges))).toEqual([])
  })
})
