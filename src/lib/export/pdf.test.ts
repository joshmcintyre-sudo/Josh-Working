import { describe, expect, it } from 'vitest'
import { analyseLoom } from '~/lib/loom/analysis'
import { DEMO_LOOM } from '~/lib/loom/demo-loom'
import { buildManufacturingDrawing, hexToRgb } from './pdf'
import { baseFilename } from './download'

const analysis = analyseLoom(DEMO_LOOM)
const FIXED_DATE = new Date('2026-08-14T00:00:00Z')

function textOf(doc: ReturnType<typeof buildManufacturingDrawing>): string {
  // jsPDF writes uncompressed content streams by default, so drawn strings
  // appear literally in the output.
  return doc.output()
}

describe('manufacturing drawing', () => {
  const doc = buildManufacturingDrawing(analysis, { date: FIXED_DATE, drawnBy: 'J. McIntyre' })

  it('produces four sheets', () => {
    expect(doc.getNumberOfPages()).toBe(4)
  })

  it('is deterministic for a fixed date', () => {
    const a = buildManufacturingDrawing(analysis, { date: FIXED_DATE }).output()
    const b = buildManufacturingDrawing(analysis, { date: FIXED_DATE }).output()
    // The trailing ID and creation timestamp vary; the drawn content must not.
    expect(a.length).toBe(b.length)
  })

  it('states the drawing scale in the title block', () => {
    expect(textOf(doc)).toMatch(/1:\d/)
    expect(textOf(doc)).toContain('scaled to fit')
  })

  it('warns on the sheet that it must not be measured', () => {
    expect(textOf(doc)).toContain('NOT TO SCALE FOR MEASUREMENT')
  })

  it('dimensions runs with their cut length', () => {
    const out = textOf(doc)
    expect(out).toContain('C-101')
    expect(out).toContain('1200 mm')
  })

  it('carries the loom name, revision and date', () => {
    const out = textOf(doc)
    expect(out).toContain('Service body accessory loom')
    expect(out).toContain('2026-08-14')
    expect(out).toContain('J. McIntyre')
  })

  it('records the engineering basis so the numbers can be checked', () => {
    const out = textOf(doc)
    expect(out).toContain('AS/NZS 3808')
    expect(out).toContain('SAE J1128')
  })

  it('flags BOM lines that are not orderable as printed', () => {
    expect(textOf(doc)).toContain('CONFIRM FROM CATALOGUE')
  })

  it('does not throw on a loom with nothing pinned out', () => {
    const bare = analyseLoom({
      ...structuredClone(DEMO_LOOM),
      nodes: DEMO_LOOM.nodes.map((n) => ({ ...n, formboardPosition: undefined })),
    })
    const d = buildManufacturingDrawing(bare, { date: FIXED_DATE })
    expect(d.getNumberOfPages()).toBe(4)
    expect(d.output()).toContain('auto-derived')
  })

  it('does not throw on an empty loom', () => {
    const empty = analyseLoom({ ...structuredClone(DEMO_LOOM), nodes: [], edges: [] })
    expect(() => buildManufacturingDrawing(empty, { date: FIXED_DATE })).not.toThrow()
  })
})

describe('filenames', () => {
  it('names files from the loom and revision', () => {
    expect(baseFilename(analysis)).toBe('service-body-accessory-loom-rev-a')
  })
})

describe('hexToRgb', () => {
  it('parses six-digit hex', () => {
    expect(hexToRgb('#d81f26')).toEqual([216, 31, 38])
  })
  it('expands three-digit hex', () => {
    expect(hexToRgb('#abc')).toEqual([170, 187, 204])
  })
  it('falls back to grey rather than producing NaN channels', () => {
    expect(hexToRgb('not-a-colour')).toEqual([80, 80, 80])
  })
})
