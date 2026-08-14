import { describe, expect, it } from 'vitest'
import {
  ambientFactor,
  bundlingFactor,
  CONNECTOR_SERIES,
  deratedAmpacity,
  FUSE_FAMILIES,
  INSULATIONS,
  resistanceAt,
  WIRE_META,
  WIRE_SIZES,
  wireSizeById,
} from './data'

describe('wire reference data', () => {
  it('has unique ids', () => {
    const ids = WIRE_SIZES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is sorted by conductor area', () => {
    const areas = WIRE_SIZES.map((s) => s.area_mm2)
    expect([...areas].sort((a, b) => a - b)).toEqual(areas)
  })

  it('quotes resistances consistent with copper resistivity over area', () => {
    // rho / A, allowing for stranding lay and rounding to published tables.
    const rho = WIRE_META.conductor.resistivity_ohm_mm2_per_m_at_20c
    for (const s of WIRE_SIZES) {
      const theoretical = rho / s.area_mm2
      const ratio = s.resistance_ohm_per_m / theoretical
      expect(ratio, `${s.label} resistance vs rho/A`).toBeGreaterThan(0.9)
      expect(ratio, `${s.label} resistance vs rho/A`).toBeLessThan(1.15)
    }
  })

  it('increases ampacity with area within each family and basis', () => {
    for (const family of ['awg', 'metric'] as const) {
      for (const basis of ['sae_j1128', 'as_nzs_3808'] as const) {
        const rows = WIRE_SIZES.filter((s) => s.family === family)
        for (let i = 1; i < rows.length; i++) {
          expect(
            rows[i]!.ampacity_a[basis],
            `${rows[i]!.label} vs ${rows[i - 1]!.label} on ${basis}`,
          ).toBeGreaterThan(rows[i - 1]!.ampacity_a[basis])
        }
      }
    }
  })

  it('rates AS/NZS more conservatively than SAE above 2 mm²', () => {
    // The two bases only diverge meaningfully once the conductor is big enough
    // to matter; below that they cross over and that is expected.
    for (const s of WIRE_SIZES.filter((x) => x.area_mm2 >= 2)) {
      expect(s.ampacity_a.as_nzs_3808, s.label).toBeLessThan(s.ampacity_a.sae_j1128)
    }
  })

  it('flags every interpolated ampacity so a drawing can cite it', () => {
    for (const s of WIRE_SIZES) {
      expect(Array.isArray(s.interpolated)).toBe(true)
      for (const basis of s.interpolated) {
        expect(['sae_j1128', 'as_nzs_3808']).toContain(basis)
      }
      expect(s.source.length).toBeGreaterThan(0)
    }
  })
})

describe('derating', () => {
  it('does not derate a single wire at the basis ambient', () => {
    expect(bundlingFactor(1)).toBe(1)
    expect(ambientFactor(30)).toBe(1)
  })

  it('derates harder as a bundle grows', () => {
    const factors = [1, 3, 6, 15, 40].map(bundlingFactor)
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]!).toBeLessThan(factors[i - 1]!)
    }
  })

  it('interpolates ambient factors between published points', () => {
    // Table has 30 -> 1.0 and 40 -> 0.93, so 35 should land halfway.
    expect(ambientFactor(35)).toBeCloseTo(0.965, 3)
  })

  it('clamps ambient factors outside the table', () => {
    expect(ambientFactor(-40)).toBe(ambientFactor(20))
    expect(ambientFactor(200)).toBe(ambientFactor(100))
  })

  it('combines ambient and bundling multiplicatively', () => {
    const size = wireSizeById('awg-16')!
    const d = deratedAmpacity(size, 'sae_j1128', 40, 10)
    expect(d.base).toBe(19)
    expect(d.value).toBeCloseTo(19 * 0.93 * 0.65, 6)
  })
})

describe('temperature correction', () => {
  it('raises copper resistance by about 0.393 % per degree', () => {
    const size = wireSizeById('awg-16')!
    // 105 °C is 85 degrees above the 20 °C table basis.
    const hot = resistanceAt(size, 105)
    expect(hot / size.resistance_ohm_per_m).toBeCloseTo(1 + 0.00393 * 85, 6)
  })

  it('returns the table value at 20 °C', () => {
    const size = wireSizeById('awg-8')!
    expect(resistanceAt(size, 20)).toBe(size.resistance_ohm_per_m)
  })
})

describe('fuse reference data', () => {
  it('lists ratings in ascending order with no duplicates', () => {
    for (const f of FUSE_FAMILIES) {
      expect([...f.ratings_a].sort((a, b) => a - b), f.id).toEqual(f.ratings_a)
      expect(new Set(f.ratings_a).size, f.id).toBe(f.ratings_a.length)
    }
  })

  it('keeps every rating within the family continuous rating', () => {
    for (const f of FUSE_FAMILIES) {
      expect(Math.max(...f.ratings_a), f.id).toBeLessThanOrEqual(f.maxContinuous_a)
    }
  })

  it('rates every family for at least a 12 V system', () => {
    for (const f of FUSE_FAMILIES) expect(f.voltageRating_v).toBeGreaterThanOrEqual(24)
  })
})

describe('connector reference data', () => {
  it('states a current rating and wire range for every series', () => {
    for (const c of CONNECTOR_SERIES) {
      expect(c.currentRating_a, c.id).toBeGreaterThan(0)
      expect(c.wireRange_mm2.length, c.id).toBe(2)
      expect(c.wireRange_mm2[1]!).toBeGreaterThan(c.wireRange_mm2[0]!)
    }
  })

  it('never states a part number without a confidence level', () => {
    for (const c of CONNECTOR_SERIES) {
      for (const h of c.housings) expect(h.pnConfidence, `${c.id} ${h.ways}-way`).toBeTruthy()
      for (const t of c.contacts) {
        expect(['high', 'medium', 'unspecified']).toContain(t.pnConfidence)
        // An unspecified confidence must not carry an invented number.
        if (t.pnConfidence === 'unspecified') expect(t.pn).toBeNull()
      }
    }
  })

  it('orders the Deutsch families by current capability', () => {
    const rating = (id: string) => CONNECTOR_SERIES.find((c) => c.id === id)!.currentRating_a
    expect(rating('deutsch-dtm')).toBeLessThan(rating('deutsch-dt'))
    expect(rating('deutsch-dt')).toBeLessThan(rating('deutsch-dtp'))
  })
})

describe('insulation data', () => {
  it('gives every insulation a temperature rating above under-bonnet ambient', () => {
    for (const i of INSULATIONS) expect(i.tempRating_c, i.id).toBeGreaterThanOrEqual(85)
  })
})
