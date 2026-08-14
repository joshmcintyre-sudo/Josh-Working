import { describe, expect, it } from 'vitest'
import { analyseLoom } from './analysis'
import { bomCsv, buildBom, buildCutList, cutListCsv, toCsv } from './bom'
import { DEMO_LOOM } from './demo-loom'

const analysis = analyseLoom(DEMO_LOOM)

describe('bill of materials', () => {
  const bom = buildBom(analysis)

  it('groups wire by size and insulation', () => {
    const wire = bom.groups.find((g) => g.title === 'Wire')!
    expect(wire.lines.length).toBeGreaterThan(1)
    // Every sized run must be represented somewhere in the wire group.
    const total = wire.lines.reduce((t, l) => t + Number(l.quantity), 0)
    expect(total).toBeGreaterThan(analysis.totals.wireLength_mm / 1000)
  })

  it('adds a cutting allowance rather than ordering the exact net length', () => {
    const wire = bom.groups.find((g) => g.title === 'Wire')!
    const net = analysis.totals.wireLength_mm / 1000
    const ordered = wire.lines.reduce((t, l) => t + Number(l.quantity), 0)
    expect(ordered).toBeGreaterThan(net)
    expect(ordered).toBeLessThan(net * 1.3)
  })

  it('lists housings, wedgelocks and contacts for each connector', () => {
    const connectors = bom.groups.find((g) => g.title === 'Connectors')!
    const dt = connectors.lines.filter((l) => l.key.startsWith('dt2_lightbar'))
    expect(dt.some((l) => l.partNumber === 'DT04-2P')).toBe(true)
    expect(dt.some((l) => l.partNumber === 'DT06-2S')).toBe(true)
    expect(dt.some((l) => l.description.includes('wedgelock'))).toBe(true)
    expect(dt.some((l) => l.partNumber === '0460-202-16141')).toBe(true)
  })

  it('counts one contact pair per terminated way', () => {
    const connectors = bom.groups.find((g) => g.title === 'Connectors')!
    // The light bar connector is passed through by two runs: feed in, feed out.
    const pins = connectors.lines.find((l) => l.key === 'dt2_lightbar-pin')!
    expect(pins.quantity).toBe(2)
  })

  it('lists a cavity seal for every unused way', () => {
    const loom = structuredClone(DEMO_LOOM)
    loom.nodes.find((n) => n.id === 'dt2_lightbar')!.connector = {
      seriesId: 'deutsch-dt',
      ways: 6,
    }
    const seals = buildBom(analyseLoom(loom))
      .groups.find((g) => g.title === 'Connectors')!
      .lines.find((l) => l.key === 'dt2_lightbar-seals')!
    expect(seals.quantity).toBe(4)
    expect(seals.partNumber).toBe('0413-204-1605')
  })

  it('rolls up fuses by rating and family', () => {
    const protection = bom.groups.find((g) => g.title === 'Protection')!
    expect(protection.lines.some((l) => l.description.includes('225 A'))).toBe(true)
    expect(protection.lines.some((l) => l.description.includes('ANL'))).toBe(true)
  })

  it('counts lines that still need a part number confirmed', () => {
    expect(bom.unresolvedPartNumbers).toBeGreaterThan(0)
    const flagged = bom.groups.flatMap((g) => g.lines).filter((l) => l.needsPartNumber)
    expect(flagged.length).toBeGreaterThan(0)
    // Nothing may be flagged as needing a number while also carrying one.
    for (const l of flagged) expect(l.partNumber).toBeUndefined()
  })

  it('sizes sleeving from the bundle rather than per conductor', () => {
    const sleeve = bom.groups.find((g) => g.title === 'Protection sleeving')
    expect(sleeve).toBeDefined()
    expect(Number(sleeve!.lines[0]!.quantity)).toBeGreaterThan(0)
  })
})

describe('cut list', () => {
  const rows = buildCutList(analysis)

  it('has one row per run', () => {
    expect(rows.length).toBe(DEMO_LOOM.edges.length)
  })

  it('carries everything needed to cut and label a wire', () => {
    const row = rows.find((r) => r.circuitId === 'C-101')!
    expect(row.from).toBe('Main battery +')
    expect(row.to).toBe('2000 W inverter')
    expect(row.length_mm).toBe(1200)
    expect(row.size).toBe('3/0 AWG')
    expect(row.fuse).toMatch(/225 A/)
    expect(row.fromLocation.length).toBeGreaterThan(0)
  })

  it('is sorted by circuit id in human order', () => {
    const ids = rows.map((r) => r.circuitId)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
  })

  it('reflects the service loop allowance in the cut length', () => {
    const withLoop = buildCutList(
      analyseLoom({ ...DEMO_LOOM, settings: { ...DEMO_LOOM.settings, serviceLoop_mm: 150 } }),
    )
    expect(withLoop.find((r) => r.circuitId === 'C-101')!.length_mm).toBe(1350)
  })
})

describe('CSV', () => {
  it('quotes every cell so a comma in a location cannot split a row', () => {
    const csv = toCsv([{ a: 'left, right', b: 'plain' }])
    expect(csv).toBe('"a","b"\r\n"left, right","plain"')
  })

  it('escapes embedded quotes', () => {
    expect(toCsv([{ a: 'say "hi"' }])).toContain('"say ""hi"""')
  })

  it('emits a header row and one row per run', () => {
    const lines = cutListCsv(analysis).split('\r\n')
    expect(lines.length).toBe(DEMO_LOOM.edges.length + 1)
    expect(lines[0]).toContain('"circuitId"')
  })

  it('marks BOM lines that need a part number confirmed', () => {
    expect(bomCsv(analysis)).toContain('"YES"')
  })

  it('returns empty string for no rows rather than a stray header', () => {
    expect(toCsv([])).toBe('')
  })
})
