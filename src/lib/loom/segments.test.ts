import { describe, expect, it } from 'vitest'
import { analyseLoom } from './analysis'
import { DEMO_LOOM } from './demo-loom'
import {
  bundleDiameter,
  chooseSleeving,
  cutLengthFor,
  findSegmentPath,
  loadSegments,
  pointAlong,
  routeWires,
} from './segments'
import type { Loom, LoomSegment } from './types'

const analysis = analyseLoom(DEMO_LOOM)

describe('finding a path through the bundle', () => {
  const segments: LoomSegment[] = [
    { id: 'a', fromNodeId: 'n1', toNodeId: 'n2', length_mm: 100 },
    { id: 'b', fromNodeId: 'n2', toNodeId: 'n3', length_mm: 100 },
    { id: 'long', fromNodeId: 'n1', toNodeId: 'n3', length_mm: 900 },
    { id: 'c', fromNodeId: 'n3', toNodeId: 'n4', length_mm: 100 },
  ]

  it('follows the shortest physical route, not the fewest branches', () => {
    // n1 -> n3 direct is one hop but 900 mm; via n2 it is two hops and 200 mm.
    const path = findSegmentPath(segments, 'n1', 'n3')
    expect(path?.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('travels in either direction along a segment', () => {
    expect(findSegmentPath(segments, 'n4', 'n1')?.map((s) => s.id)).toEqual(['c', 'b', 'a'])
  })

  it('returns an empty path for a node to itself', () => {
    expect(findSegmentPath(segments, 'n1', 'n1')).toEqual([])
  })

  it('returns null when the bundle does not reach', () => {
    expect(findSegmentPath(segments, 'n1', 'nowhere')).toBeNull()
  })

  it('does not hang on a loop in the bundle', () => {
    const looped: LoomSegment[] = [
      ...segments,
      { id: 'loop', fromNodeId: 'n4', toNodeId: 'n1', length_mm: 50 },
    ]
    expect(findSegmentPath(looped, 'n1', 'n4')?.map((s) => s.id)).toEqual(['loop'])
  })
})

describe('routing the demo loom', () => {
  const routing = routeWires(DEMO_LOOM)

  it('threads the roof wires up the trunk and out the breakout', () => {
    expect(routing.get('e-fb-lightbar')!.segmentIds).toEqual(['seg-cab-roof', 'seg-roof-lb'])
    expect(routing.get('e-fb-strobe')!.segmentIds).toEqual(['seg-cab-roof', 'seg-roof-st'])
  })

  it('routes a return all the way back through the trunk', () => {
    // The return leaves the roof connector and threads back down the trunk.
    const back = routing.get('e-dtcon-gnd')!
    expect(back.segmentIds).toEqual(['seg-roof-lb', 'seg-cab-roof', 'seg-cab-gnd'])
    expect(back.bundleLength_mm).toBe(300 + 2100 + 200)
  })

  it('leaves nothing unrouted', () => {
    for (const [id, r] of routing) expect(r.unrouted, id).toBe(false)
  })

  it('honours a path a wire names for itself', () => {
    const forced: Loom = structuredClone(DEMO_LOOM)
    forced.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds = ['seg-cab-rear']
    const r = routeWires(forced).get('e-fb-lightbar')!
    expect(r.segmentIds).toEqual(['seg-cab-rear'])
    expect(r.explicit).toBe(true)
  })

  it('treats a named path with a missing segment as unrouted rather than short', () => {
    const broken: Loom = structuredClone(DEMO_LOOM)
    broken.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds = ['seg-cab-roof', 'gone']
    expect(routeWires(broken).get('e-fb-lightbar')!.unrouted).toBe(true)
  })

  it('leaves every wire unrouted on a loom with no bundles', () => {
    const loose: Loom = { ...structuredClone(DEMO_LOOM), segments: [] }
    for (const r of routeWires(loose).values()) expect(r.unrouted).toBe(true)
  })
})

describe('cut length from routing', () => {
  it('takes the length from the bundle when the run is set to follow it', () => {
    const routing = routeWires(DEMO_LOOM)
    const edge = DEMO_LOOM.edges.find((e) => e.id === 'e-dtcon-gnd')!
    expect(edge.lengthFromRouting).toBe(true)
    expect(cutLengthFor(edge, routing.get(edge.id))).toBe(2600)
  })

  it('adds the tails to the bundle length', () => {
    const withTails: Loom = structuredClone(DEMO_LOOM)
    withTails.settings.defaultTail_mm = 100
    const routing = routeWires(withTails)
    const edge = withTails.edges.find((e) => e.id === 'e-fb-lightbar')!
    // 2400 mm of bundle plus 100 mm a side.
    expect(cutLengthFor(edge, routing.get(edge.id))).toBe(2600)
  })

  it('falls back to the authored length when the wire is not in a bundle', () => {
    const loose: Loom = { ...structuredClone(DEMO_LOOM), segments: [] }
    const routing = routeWires(loose)
    const edge = loose.edges.find((e) => e.id === 'e-fb-lightbar')!
    expect(cutLengthFor(edge, routing.get(edge.id))).toBe(edge.length_mm)
  })

  it('re-lengths every wire in a trunk when the trunk is moved', () => {
    const longer: Loom = structuredClone(DEMO_LOOM)
    longer.segments!.find((s) => s.id === 'seg-cab-roof')!.length_mm = 3100
    const after = analyseLoom(longer)
    // Both roof feeds and both roof returns travel that trunk.
    expect(after.byEdgeId['e-fb-lightbar']!.effectiveLength_mm).toBe(3400)
    expect(after.byEdgeId['e-dtcon-gnd']!.effectiveLength_mm).toBe(3600)
  })
})

describe('bundle diameter', () => {
  it('is the conductor itself for a single wire', () => {
    expect(bundleDiameter([6.4])).toBe(6.4)
  })

  it('grows with the square root of the count, not linearly', () => {
    const four = bundleDiameter([3, 3, 3, 3])
    expect(four).toBeGreaterThan(3 * 2)
    expect(four).toBeLessThan(3 * 4)
  })

  it('is dominated by the fattest conductor in a mixed bundle', () => {
    expect(bundleDiameter([12, 2, 2])).toBeGreaterThan(12)
    expect(bundleDiameter([12, 2, 2])).toBeLessThan(16)
  })

  it('is zero for an empty bundle', () => {
    expect(bundleDiameter([])).toBe(0)
  })
})

describe('sleeving selection', () => {
  it('picks a sleeve whose range contains the bundle', () => {
    const sleeve = chooseSleeving(11)!
    expect(11).toBeGreaterThanOrEqual(sleeve.bundleOd_mm[0]!)
    expect(11).toBeLessThanOrEqual(sleeve.bundleOd_mm[1]!)
  })

  it('offers the widest catalogued sleeve rather than nothing when oversized', () => {
    expect(chooseSleeving(500)).not.toBeNull()
  })

  it('offers nothing for an empty bundle', () => {
    expect(chooseSleeving(0)).toBeNull()
  })
})

describe('segment loads on the demo', () => {
  it('counts the wires sharing the roof trunk', () => {
    const roof = analysis.segments.find((s) => s.segment.id === 'seg-cab-roof')!
    expect(roof.edgeIds.sort()).toEqual(
      ['e-fb-lightbar', 'e-fb-strobe', 'e-dtcon-gnd', 'e-dtmcon-gnd'].sort(),
    )
    expect(roof.bundleOd_mm).toBeGreaterThan(0)
  })

  it('accumulates conductor mass along a bundle', () => {
    const roof = analysis.segments.find((s) => s.segment.id === 'seg-cab-roof')!
    expect(roof.mass_g).toBeGreaterThan(0)
  })

  it('flags sleeving that is too small to close over the bundle', () => {
    const tight: Loom = structuredClone(DEMO_LOOM)
    tight.segments!.find((s) => s.id === 'seg-bat-inv')!.sleevingId = 'convoluted-7'
    const a = analyseLoom(tight)
    expect(a.issues.some((i) => i.code === 'sleeving_undersized' && i.severity === 'error')).toBe(
      true,
    )
  })

  it('warns about a bundle carrying nothing', () => {
    const spare: Loom = structuredClone(DEMO_LOOM)
    spare.nodes.push({
      id: 'spare-a',
      kind: 'splice',
      name: 'Spare',
      location: '',
      position: { x: 0, y: 0 },
      splice: { method: 'crimp' },
    })
    spare.segments!.push({
      id: 'seg-spare',
      fromNodeId: 'spare-a',
      toNodeId: 'gnd_chassis',
      length_mm: 100,
    })
    expect(analyseLoom(spare).issues.some((i) => i.code === 'empty_segment')).toBe(true)
  })

  it('warns about a wire left outside every bundle', () => {
    const stray: Loom = structuredClone(DEMO_LOOM)
    stray.nodes.push({
      id: 'stray',
      kind: 'load',
      name: 'Stray lamp',
      location: '',
      position: { x: 0, y: 0 },
      load: { continuousCurrent_a: 1, duty: 'continuous' },
    })
    stray.edges.push({
      id: 'e-stray',
      fromNodeId: 'fuseblock',
      toNodeId: 'stray',
      circuitId: 'C-999',
      length_mm: 500,
      class: 'power',
      returnPath: 'modeled',
      protection: { familyId: 'ato' },
    })
    expect(analyseLoom(stray).issues.some((i) => i.code === 'unrouted_wire')).toBe(true)
  })

  it('does not report bundles on a loom that has none', () => {
    const loose: Loom = { ...structuredClone(DEMO_LOOM), segments: [] }
    const a = analyseLoom(loose)
    expect(a.segments).toEqual([])
    expect(a.issues.some((i) => i.code === 'unrouted_wire')).toBe(false)
  })
})

describe('pointAlong', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]

  it('finds the midpoint of a straight run', () => {
    expect(pointAlong(line, 0.5)).toEqual({ x: 50, y: 0 })
  })

  it('measures by distance across a multi-segment polyline', () => {
    const bent = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(pointAlong(bent, 0.5)).toEqual({ x: 100, y: 0 })
    expect(pointAlong(bent, 0.75)).toEqual({ x: 100, y: 50 })
  })

  it('clamps outside 0..1', () => {
    expect(pointAlong(line, -5)).toEqual({ x: 0, y: 0 })
    expect(pointAlong(line, 5)).toEqual({ x: 100, y: 0 })
  })

  it('survives a zero-length path', () => {
    expect(pointAlong([{ x: 7, y: 7 }, { x: 7, y: 7 }], 0.5)).toEqual({ x: 7, y: 7 })
  })
})

describe('loadSegments with nothing sized', () => {
  it('reports a zero bundle rather than throwing', () => {
    const loads = loadSegments(DEMO_LOOM, routeWires(DEMO_LOOM), () => null)
    for (const l of loads) expect(l.bundleOd_mm).toBe(0)
  })
})
