import { describe, expect, it } from 'vitest'
import { analyseLoom } from './analysis'
import { DEMO_LOOM } from './demo-loom'
import {
  addSegment,
  duplicateBranch,
  duplicateEdge,
  duplicateNode,
  inferWireClass,
  insertSpliceInRun,
  nextCopyName,
  nodeDeletionImpact,
  removeNode,
  removeSegment,
  segmentDeletionImpact,
  splitSegment,
} from './mutations'
import type { Loom } from './types'

describe('inserting a splice into a run', () => {
  it('splits the run in two and puts a splice between them', () => {
    const { loom, spliceId, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 500)
    const splice = loom.nodes.find((n) => n.id === spliceId)!
    expect(splice.kind).toBe('splice')
    const [first, second] = edgeIds.map((id) => loom.edges.find((e) => e.id === id)!)
    expect(first!.fromNodeId).toBe('fuseblock')
    expect(first!.toNodeId).toBe(spliceId)
    expect(second!.fromNodeId).toBe(spliceId)
    expect(second!.toNodeId).toBe('locking')
  })

  it('preserves the total length exactly', () => {
    const original = DEMO_LOOM.edges.find((e) => e.id === 'e-fb-locking')!.length_mm
    const { loom, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 500)
    const total = edgeIds
      .map((id) => loom.edges.find((e) => e.id === id)!.length_mm)
      .reduce((a, b) => a + b, 0)
    expect(total).toBe(original)
  })

  it('keeps the protection on the source half only', () => {
    const { loom, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 500)
    const [first, second] = edgeIds.map((id) => loom.edges.find((e) => e.id === id)!)
    expect(first!.protection).toBeDefined()
    expect(second!.protection).toBeUndefined()
  })

  it('lands the splice proportionally along the board path', () => {
    const { loom, spliceId } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 900)
    const from = DEMO_LOOM.nodes.find((n) => n.id === 'fuseblock')!.formboardPosition!
    const to = DEMO_LOOM.nodes.find((n) => n.id === 'locking')!.formboardPosition!
    const splice = loom.nodes.find((n) => n.id === spliceId)!.formboardPosition!
    // Half way along a 1800 mm run.
    expect(splice.x).toBeCloseTo((from.x + to.x) / 2, 0)
    expect(splice.y).toBeCloseTo((from.y + to.y) / 2, 0)
  })

  it('keeps the circuit id on both halves', () => {
    const { loom, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 500)
    for (const id of edgeIds) {
      expect(loom.edges.find((e) => e.id === id)!.circuitId).toBe('C-204')
    }
  })

  it('keeps the loom analysable, with current unchanged through the splice', () => {
    const before = analyseLoom(DEMO_LOOM).byEdgeId['e-fb-locking']!.current_a
    const { loom, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 500)
    const after = analyseLoom(loom)
    for (const id of edgeIds) expect(after.byEdgeId[id]!.current_a).toBe(before)
    expect(after.errorCount).toBe(analyseLoom(DEMO_LOOM).errorCount)
  })

  it('refuses to splice a run that does not exist', () => {
    expect(() => insertSpliceInRun(DEMO_LOOM, 'nope', 100)).toThrow(/No run/)
  })

  it('clamps a distance past either end rather than making a zero-length wire', () => {
    const { loom, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 99999)
    for (const id of edgeIds) {
      expect(loom.edges.find((e) => e.id === id)!.length_mm).toBeGreaterThan(0)
    }
  })

  it('splits the bundle too, so the splice lands on the trunk', () => {
    // C-204 travels inside the central-locking bundle. Splicing it at 900 mm
    // must break that bundle at the same point, not leave the halves loose.
    const before = DEMO_LOOM.segments!.length
    const { loom, spliceId } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 900)
    expect(loom.segments!.length).toBe(before + 1)
    expect(
      loom.segments!.some((s) => s.fromNodeId === spliceId || s.toNodeId === spliceId),
    ).toBe(true)
  })

  it('leaves both halves routed rather than loose', () => {
    const { loom, edgeIds } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 900)
    const after = analyseLoom(loom)
    for (const id of edgeIds) expect(after.byEdgeId[id]!.routing!.unrouted).toBe(false)
    expect(after.issues.filter((i) => i.code === 'unrouted_wire')).toEqual([])
  })

  it('introduces no new errors', () => {
    const before = analyseLoom(DEMO_LOOM)
    const { loom } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 900)
    expect(analyseLoom(loom).errorCount).toBe(before.errorCount)
  })

  it('keeps both halves on one gauge', () => {
    // Sized independently the shorter half would take a smaller gauge, which
    // would put two reels on the bench for one circuit. The circuit-match pass
    // lifts it back, so splicing never silently changes what gets cut.
    const free = structuredClone(DEMO_LOOM)
    for (const e of free.edges) if (e.circuitId === 'C-204') e.gaugeOverrideId = undefined
    const { loom, edgeIds } = insertSpliceInRun(free, 'e-fb-locking', 300)
    const a = analyseLoom(loom)
    const sizes = edgeIds.map((id) => a.byEdgeId[id]!.sizing.size!.id)
    expect(new Set(sizes).size).toBe(1)
    expect(a.issues.some((i) => i.code === 'mixed_gauge_circuit')).toBe(false)
  })

  it('still flags a circuit left mixed by a manual override', () => {
    const mixed = structuredClone(DEMO_LOOM)
    const { loom, edgeIds } = insertSpliceInRun(mixed, 'e-fb-locking', 300)
    // Force one half smaller by hand; the check must not stay quiet about it.
    loom.edges.find((e) => e.id === edgeIds[1])!.gaugeOverrideId = 'awg-20'
    expect(analyseLoom(loom).issues.some((i) => i.code === 'mixed_gauge_circuit')).toBe(true)
  })

  it('keeps the bundle length the same across the split', () => {
    const before = DEMO_LOOM.segments!.find((s) => s.id === 'seg-cab-lock')!.length_mm
    const { loom, spliceId } = insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 900)
    const halves = loom.segments!.filter(
      (s) => s.fromNodeId === spliceId || s.toNodeId === spliceId,
    )
    expect(halves.reduce((t, s) => t + s.length_mm, 0)).toBe(before)
  })

  it('leaves bundles alone when the wire is not in one', () => {
    const loose: Loom = { ...structuredClone(DEMO_LOOM), segments: [] }
    const { loom } = insertSpliceInRun(loose, 'e-fb-locking', 900)
    expect(loom.segments).toEqual([])
  })

  it('does not mutate the original loom', () => {
    const before = DEMO_LOOM.edges.length
    insertSpliceInRun(DEMO_LOOM, 'e-fb-locking', 500)
    expect(DEMO_LOOM.edges.length).toBe(before)
  })
})

describe('splitting a bundle', () => {
  it('breaks the bundle in two with a breakout node between', () => {
    const { loom, nodeId, segmentIds } = splitSegment(DEMO_LOOM, 'seg-cab-roof', 1000)
    const [a, b] = segmentIds.map((id) => loom.segments!.find((s) => s.id === id)!)
    expect(a!.fromNodeId).toBe('fuseblock')
    expect(a!.toNodeId).toBe(nodeId)
    expect(b!.fromNodeId).toBe(nodeId)
    expect(b!.toNodeId).toBe('roof_breakout')
    expect(a!.length_mm + b!.length_mm).toBe(2100)
  })

  it('carries the sleeving onto both halves', () => {
    const { loom, segmentIds } = splitSegment(DEMO_LOOM, 'seg-cab-roof', 1000)
    for (const id of segmentIds) {
      expect(loom.segments!.find((s) => s.id === id)!.sleevingId).toBe('convoluted-10')
    }
  })

  it('leaves the wires inside travelling the same total distance', () => {
    const before = analyseLoom(DEMO_LOOM).byEdgeId['e-fb-lightbar']!.effectiveLength_mm
    const { loom } = splitSegment(DEMO_LOOM, 'seg-cab-roof', 1000)
    expect(analyseLoom(loom).byEdgeId['e-fb-lightbar']!.effectiveLength_mm).toBe(before)
  })

  it('rewrites a wire that named the split segment explicitly', () => {
    const named: Loom = structuredClone(DEMO_LOOM)
    named.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds = ['seg-cab-roof', 'seg-roof-lb']
    const { loom, segmentIds } = splitSegment(named, 'seg-cab-roof', 1000)
    expect(loom.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds).toEqual([
      segmentIds[0],
      segmentIds[1],
      'seg-roof-lb',
    ])
  })

  it('can drop a connector at the break instead of a splice', () => {
    const { loom, nodeId } = splitSegment(DEMO_LOOM, 'seg-cab-roof', 1000, { kind: 'connector' })
    const node = loom.nodes.find((n) => n.id === nodeId)!
    expect(node.kind).toBe('connector')
    expect(node.connector).toBeDefined()
  })
})

describe('duplicating', () => {
  it('copies a load with its ratings but not its connections', () => {
    const { loom, nodeId } = duplicateNode(DEMO_LOOM, 'lightbar')
    const copy = loom.nodes.find((n) => n.id === nodeId)!
    expect(copy.load).toEqual(DEMO_LOOM.nodes.find((n) => n.id === 'lightbar')!.load)
    expect(loom.edges.filter((e) => e.fromNodeId === nodeId || e.toNodeId === nodeId)).toEqual([])
  })

  it('offsets the copy so it does not hide under the original', () => {
    const source = DEMO_LOOM.nodes.find((n) => n.id === 'lightbar')!
    const { loom, nodeId } = duplicateNode(DEMO_LOOM, 'lightbar')
    const copy = loom.nodes.find((n) => n.id === nodeId)!
    expect(copy.position).not.toEqual(source.position)
    expect(copy.formboardPosition).not.toEqual(source.formboardPosition)
  })

  it('numbers the copy rather than repeating the name', () => {
    expect(nextCopyName('LED light bar', ['LED light bar'])).toBe('LED light bar 2')
    expect(nextCopyName('LED light bar 2', ['LED light bar', 'LED light bar 2'])).toBe(
      'LED light bar 3',
    )
  })

  it('copies a run including its overrides', () => {
    const { loom, edgeId } = duplicateEdge(DEMO_LOOM, 'e-inv-gnd')
    const copy = loom.edges.find((e) => e.id === edgeId)!
    expect(copy.gaugeOverrideId).toBe('awg-3-0')
    expect(copy.id).not.toBe('e-inv-gnd')
  })

  it('deep copies, so editing the copy leaves the original alone', () => {
    const { loom, nodeId } = duplicateNode(DEMO_LOOM, 'lightbar')
    loom.nodes.find((n) => n.id === nodeId)!.load!.continuousCurrent_a = 99
    expect(DEMO_LOOM.nodes.find((n) => n.id === 'lightbar')!.load!.continuousCurrent_a).toBe(10)
  })
})

describe('duplicating a whole branch', () => {
  // The strobe hangs off the roof trunk through its own Deutsch DTM connector:
  // fuseblock -> [dtm2_strobe] -> strobe, and back dtm2_strobe -> gnd_cab.
  // Root = dtm2_strobe. Upstream = e-fb-strobe (power in) and e-dtmcon-gnd
  // (ground out). Branch = dtm2_strobe + strobe, joined by e-dtm-strobe and
  // e-strobe-gnd, bundled together by seg-st-load.
  it('copies the connector and the device beyond it, not the rest of the loom', () => {
    const r = duplicateBranch(DEMO_LOOM, 'dtm2_strobe', { nodeId: 'roof_breakout' })
    expect(r.nodeIds.length).toBe(2)
    const clones = r.loom.nodes.filter((n) => r.nodeIds.includes(n.id))
    expect(clones.map((n) => n.kind).sort()).toEqual(['connector', 'load'])
    expect(clones.find((n) => n.kind === 'load')!.name).toBe('Amber strobe beacon 2')
    // Nothing outside the branch was touched.
    expect(r.loom.nodes.length).toBe(DEMO_LOOM.nodes.length + 2)
  })

  it('rebuilds the feed and return at the chosen attachment point, same circuit, same length', () => {
    const r = duplicateBranch(DEMO_LOOM, 'dtm2_strobe', { nodeId: 'roof_breakout' })
    const newEdges = r.loom.edges.filter((e) => r.edgeIds.includes(e.id))
    expect(newEdges.length).toBe(4) // feed-in, ground-out, + the 2 branch-internal runs

    const feed = newEdges.find((e) => e.fromNodeId === 'roof_breakout')!
    expect(feed.circuitId).toBe('C-202')
    expect(feed.length_mm).toBe(2600) // same as the original e-fb-strobe
    expect(feed.protection).toEqual({ familyId: 'ato' }) // carried over, not lost

    // Ground is a shared bus, not the trunk being spliced — the new return
    // goes straight to the same chassis point the original used.
    const ret = newEdges.find((e) => e.toNodeId === 'gnd_cab')!
    expect(ret.circuitId).toBe('C-202G')
    expect(ret.length_mm).toBe(2800) // same as the original e-dtmcon-gnd
  })

  it('does not double the original current draw — each copy sizes on its own', () => {
    const r = duplicateBranch(DEMO_LOOM, 'dtm2_strobe', { nodeId: 'roof_breakout' })
    const a = analyseLoom(r.loom)
    const clonedFeed = a.edges.find((e) => r.edgeIds.includes(e.edge.id) && e.edge.class === 'power')!
    expect(clonedFeed.current_a).toBe(1) // the strobe's own 1 A, not 2
    expect(a.errorCount).toBe(0)
  })

  it('can attach via a fresh breakout split from a trunk segment, at the chosen distance', () => {
    const r = duplicateBranch(DEMO_LOOM, 'dtm2_strobe', { segmentId: 'seg-cab-roof', distance_mm: 400 })
    const branch = r.loom.nodes.find((n) => n.id === r.branchNodeId)!
    expect(branch.kind).toBe('splice')
    const original = DEMO_LOOM.segments!.find((s) => s.id === 'seg-cab-roof')!
    const halves = r.loom.segments!.filter(
      (s) => s.fromNodeId === original.fromNodeId || s.toNodeId === original.toNodeId,
    )
    expect(halves.some((s) => s.length_mm === 400)).toBe(true)
  })

  it('refuses to duplicate a node with nothing connecting it to the rest of the loom', () => {
    const loom: Loom = {
      ...DEMO_LOOM,
      nodes: [
        ...DEMO_LOOM.nodes,
        {
          id: 'floating',
          kind: 'load',
          name: 'Floating',
          location: 'x',
          position: { x: 0, y: 0 },
        },
      ],
    }
    expect(() => duplicateBranch(loom, 'floating', { nodeId: 'roof_breakout' })).toThrow()
  })
})

describe('deletion impact', () => {
  it('reports the runs and bundles a node takes with it', () => {
    const impact = nodeDeletionImpact(DEMO_LOOM, 'fuseblock')
    expect(impact.edgeIds.length).toBeGreaterThan(3)
    expect(impact.segmentIds).toContain('seg-cab-roof')
  })

  it('removes those runs and bundles when applied', () => {
    const loom = removeNode(DEMO_LOOM, 'fuseblock')
    expect(loom.nodes.find((n) => n.id === 'fuseblock')).toBeUndefined()
    expect(loom.edges.some((e) => e.fromNodeId === 'fuseblock' || e.toNodeId === 'fuseblock')).toBe(
      false,
    )
    expect(
      loom.segments!.some((s) => s.fromNodeId === 'fuseblock' || s.toNodeId === 'fuseblock'),
    ).toBe(false)
  })

  it('reports which wires lose an explicit route when a bundle goes', () => {
    const named: Loom = structuredClone(DEMO_LOOM)
    named.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds = ['seg-cab-roof']
    expect(segmentDeletionImpact(named, 'seg-cab-roof').reroutedEdgeIds).toContain('e-fb-lightbar')
  })

  it('drops a dangling reference rather than leaving it when a bundle goes', () => {
    const named: Loom = structuredClone(DEMO_LOOM)
    named.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds = ['seg-cab-roof', 'seg-roof-lb']
    const loom = removeSegment(named, 'seg-cab-roof')
    expect(loom.edges.find((e) => e.id === 'e-fb-lightbar')!.segmentIds).toEqual(['seg-roof-lb'])
  })
})

describe('inferring the class of a new run', () => {
  it('calls a run into a ground node a return', () => {
    expect(inferWireClass(DEMO_LOOM, 'lightbar', 'gnd_chassis')).toBe('ground')
  })

  it('calls a run into a ground splice a return', () => {
    // gnd_cab collects only returns, so a new wire into it is one too. This is
    // the case that used to come out red.
    expect(inferWireClass(DEMO_LOOM, 'buzzer', 'gnd_cab')).toBe('ground')
  })

  it('does not call a run into the accessory fuse block a return', () => {
    expect(inferWireClass(DEMO_LOOM, 'busbar', 'fuseblock')).toBe('power')
  })

  it('treats a run leaving a load as a return', () => {
    expect(inferWireClass(DEMO_LOOM, 'lightbar', 'roof_breakout')).toBe('ground')
  })
})

describe('adding a bundle', () => {
  it('creates a segment with a fresh id', () => {
    const { loom, segmentId } = addSegment(DEMO_LOOM, 'buzzer', 'locking', 400)
    const seg = loom.segments!.find((s) => s.id === segmentId)!
    expect(seg.length_mm).toBe(400)
    expect(loom.segments!.length).toBe(DEMO_LOOM.segments!.length + 1)
  })

  it('works on a loom that had no bundles at all', () => {
    const loose: Loom = { ...structuredClone(DEMO_LOOM), segments: undefined }
    const { loom } = addSegment(loose, 'buzzer', 'locking', 400)
    expect(loom.segments).toHaveLength(1)
  })
})
