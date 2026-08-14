import { describe, expect, it } from 'vitest'
import { analyseLoom } from './analysis'
import { DEMO_LOOM } from './demo-loom'
import { buildFormboard, deriveFormboardPositions, fitScale, DEFAULT_BOARD } from './formboard'
import type { Loom } from './types'

const analysis = analyseLoom(DEMO_LOOM)

describe('deriving board positions', () => {
  it('keeps hand-placed positions untouched', () => {
    const positions = deriveFormboardPositions(DEMO_LOOM)
    const bat = DEMO_LOOM.nodes.find((n) => n.id === 'bat')!
    expect(positions.get('bat')).toEqual({ ...bat.formboardPosition, derived: false })
  })

  it('scales the schematic onto the board when nothing is placed', () => {
    const bare: Loom = {
      ...structuredClone(DEMO_LOOM),
      nodes: DEMO_LOOM.nodes.map((n) => ({ ...n, formboardPosition: undefined })),
    }
    const positions = deriveFormboardPositions(bare)
    expect(positions.size).toBe(bare.nodes.length)
    for (const p of positions.values()) {
      expect(p.derived).toBe(true)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(bare.formboard!.width_mm)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(bare.formboard!.height_mm)
    }
  })

  it('preserves the schematic aspect ratio rather than stretching it', () => {
    const bare: Loom = {
      ...structuredClone(DEMO_LOOM),
      nodes: DEMO_LOOM.nodes.map((n) => ({ ...n, formboardPosition: undefined })),
    }
    const positions = deriveFormboardPositions(bare)
    const a = positions.get('bat')!
    const b = positions.get('lightbar')!
    const sa = DEMO_LOOM.nodes.find((n) => n.id === 'bat')!.position
    const sb = DEMO_LOOM.nodes.find((n) => n.id === 'lightbar')!.position
    const boardRatio = (b.x - a.x) / (b.y - a.y)
    const schematicRatio = (sb.x - sa.x) / (sb.y - sa.y)
    expect(boardRatio).toBeCloseTo(schematicRatio, 1)
  })

  it('mixes placed and derived positions without moving the placed ones', () => {
    const mixed: Loom = structuredClone(DEMO_LOOM)
    mixed.nodes.find((n) => n.id === 'lightbar')!.formboardPosition = undefined
    const positions = deriveFormboardPositions(mixed)
    expect(positions.get('bat')!.derived).toBe(false)
    expect(positions.get('lightbar')!.derived).toBe(true)
  })

  it('does not fall over on a single-node loom', () => {
    const one: Loom = { ...structuredClone(DEMO_LOOM), nodes: [
      { ...DEMO_LOOM.nodes[0]!, formboardPosition: undefined },
    ], edges: [] }
    const positions = deriveFormboardPositions(one)
    const p = positions.get(one.nodes[0]!.id)!
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
  })
})

describe('formboard layout', () => {
  const board = buildFormboard(analysis)

  it('places every node and draws every run', () => {
    expect(board.nodes.length).toBe(DEMO_LOOM.nodes.length)
    expect(board.runs.length).toBe(DEMO_LOOM.edges.length)
  })

  it('marks the points where the loom physically splits', () => {
    const ids = board.branchPoints.map((b) => b.id)
    // The fuse block feeds four circuits; the cab ground splice collects four.
    expect(ids).toContain('fuseblock')
    expect(ids).toContain('gnd_cab')
    // A lamp at the end of a run is not a branch.
    expect(ids).not.toContain('lightbar')
  })

  it('carries the authored cut length, not the drawn distance', () => {
    const c101 = board.runs.find((r) => r.circuitId === 'C-101')!
    expect(c101.cutLength_mm).toBe(1200)
    expect(c101.drawnLength_mm).not.toBe(c101.cutLength_mm)
  })

  it('does not flag wires that live inside a bundle', () => {
    // The bundle owns the geometry for the wires inside it, so comparing each
    // wire's cut length to a straight line between its end nodes is meaningless.
    expect(board.lengthMismatches).toEqual([])
  })

  it('still flags a loose wire whose drawn path disagrees with its length', () => {
    const loose = structuredClone(DEMO_LOOM)
    loose.segments = []
    const mismatches = buildFormboard(analyseLoom(loose)).lengthMismatches
    expect(mismatches.length).toBeGreaterThan(0)
    for (const m of mismatches) {
      expect(Math.abs(m.cutLength_mm - m.drawnLength_mm) / m.cutLength_mm).toBeGreaterThan(0.1)
    }
  })

  it('follows an explicit routing polyline when one is given', () => {
    const routed = structuredClone(DEMO_LOOM)
    routed.edges.find((e) => e.id === 'e-bus-fb')!.routing = [
      { x: 700, y: 200 },
      { x: 900, y: 400 },
    ]
    const withRouting = buildFormboard(analyseLoom(routed))
    const run = withRouting.runs.find((r) => r.edgeId === 'e-bus-fb')!
    expect(run.points.length).toBe(4)
    const direct = buildFormboard(analysis).runs.find((r) => r.edgeId === 'e-bus-fb')!
    expect(run.drawnLength_mm).toBeGreaterThan(direct.drawnLength_mm)
  })

  it('knows when nothing has been pinned by hand yet', () => {
    expect(board.fullyDerived).toBe(false)
    const bare = analyseLoom({
      ...structuredClone(DEMO_LOOM),
      nodes: DEMO_LOOM.nodes.map((n) => ({ ...n, formboardPosition: undefined })),
    })
    expect(buildFormboard(bare).fullyDerived).toBe(true)
  })
})

describe('drawing scale', () => {
  it('picks a scale a person would write on a drawing', () => {
    // 2400 x 1200 board onto an A3 sheet with margins.
    const s = fitScale(DEFAULT_BOARD, { width_mm: 400, height_mm: 277 })
    expect(s.denominator).toBe(10)
    expect(s.ratio).toBeCloseTo(0.1, 6)
  })

  it('never scales up past 1:1', () => {
    const s = fitScale({ width_mm: 100, height_mm: 50 }, { width_mm: 400, height_mm: 277 })
    expect(s.denominator).toBe(1)
  })

  it('always chooses a scale that actually fits', () => {
    for (const board of [
      { width_mm: 2400, height_mm: 1200 },
      { width_mm: 5000, height_mm: 900 },
      { width_mm: 800, height_mm: 2000 },
    ]) {
      const sheet = { width_mm: 400, height_mm: 277 }
      const s = fitScale(board, sheet)
      expect(board.width_mm * s.ratio).toBeLessThanOrEqual(sheet.width_mm)
      expect(board.height_mm * s.ratio).toBeLessThanOrEqual(sheet.height_mm)
    }
  })
})

describe('exact fit scale', () => {
  it('fills the sheet on the binding axis', async () => {
    const { exactFitScale } = await import('./formboard')
    const sheet = { width_mm: 400, height_mm: 241 }
    const s = exactFitScale(DEFAULT_BOARD, sheet)
    expect(DEFAULT_BOARD.width_mm * s.ratio).toBeCloseTo(400, 6)
    expect(DEFAULT_BOARD.height_mm * s.ratio).toBeLessThanOrEqual(241)
  })

  it('labels the ratio honestly rather than rounding to a standard scale', async () => {
    const { exactFitScale } = await import('./formboard')
    expect(exactFitScale(DEFAULT_BOARD, { width_mm: 400, height_mm: 241 }).label).toBe(
      '1:6.0 (scaled to fit)',
    )
  })

  it('says 1:1 when the board already fits', async () => {
    const { exactFitScale } = await import('./formboard')
    expect(exactFitScale({ width_mm: 200, height_mm: 100 }, { width_mm: 200, height_mm: 200 }).label).toBe('1:1')
  })
})

describe('bundle geometry', () => {
  it('measures the drawn path of a straight bundle against its stated length', () => {
    const board = buildFormboard(analysis)
    const roof = board.trunks.find((t) => t.segmentId === 'seg-cab-roof')!
    expect(roof.drawnLength_mm).toBeGreaterThan(0)
    expect(typeof roof.lengthMismatch).toBe('boolean')
  })

  it('flags a bundle bent so far it no longer matches its stated length', () => {
    const bent = structuredClone(DEMO_LOOM)
    const seg = bent.segments!.find((s) => s.id === 'seg-cab-rear')!
    // Drag it a long way off the straight line between its ends.
    seg.routing = [{ x: 100, y: 100 }]
    const trunk = buildFormboard(analyseLoom(bent)).trunks.find(
      (t) => t.segmentId === 'seg-cab-rear',
    )!
    expect(trunk.points).toHaveLength(3)
    expect(trunk.lengthMismatch).toBe(true)
  })

  it('places tie marks along the bent path, not the straight line', () => {
    const bent = structuredClone(DEMO_LOOM)
    const seg = bent.segments!.find((s) => s.id === 'seg-cab-roof')!
    seg.routing = [{ x: 100, y: 1100 }]
    const trunk = buildFormboard(analyseLoom(bent)).trunks.find(
      (t) => t.segmentId === 'seg-cab-roof',
    )!
    expect(trunk.tiePoints).toHaveLength(3)
    // At least one tie should have been pulled toward the bend.
    expect(trunk.tiePoints.some((t) => t.x < 600)).toBe(true)
  })
})
