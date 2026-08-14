import { describe, expect, it } from 'vitest'
import {
  ACCESSORY_CATALOG,
  accessoryById,
  connectorSeriesFor,
  fuseFamilyFor,
  nodeFromAccessory,
  protectionFor,
  wireClassFor,
} from './accessories'
import { connectorSeriesById, deratedAmpacity, fuseFamilyById, WIRE_SIZES } from './data'
import { selectFuse } from './fuse-selection'

/** Smallest catalogued conductor at or above a given area. */
function sizeForArea(mm2: number) {
  return WIRE_SIZES.find((s) => s.area_mm2 >= mm2)!
}

describe('accessory catalogue', () => {
  it('has unique ids', () => {
    const ids = ACCESSORY_CATALOG.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('maps every fuse type onto a real fuse family and rating', () => {
    for (const a of ACCESSORY_CATALOG) {
      const family = fuseFamilyById(fuseFamilyFor(a))
      expect(family, a.id).toBeDefined()
      expect(family!.ratings_a, `${a.id} ${a.fuseA} A in ${family!.id}`).toContain(a.fuseA)
    }
  })

  it('maps every connector shorthand onto a real series or an explicit stud', () => {
    for (const a of ACCESSORY_CATALOG) {
      const seriesId = connectorSeriesFor(a)
      if (seriesId === null) {
        expect(a.connector, a.id).toMatch(/^(Anderson|RingLug)/)
      } else {
        expect(connectorSeriesById(seriesId), a.id).toBeDefined()
      }
    }
  })

  it('recommends a fuse at or above the continuous draw', () => {
    for (const a of ACCESSORY_CATALOG) {
      expect(a.fuseA, a.id).toBeGreaterThanOrEqual(a.runCurrentA)
    }
  })

  it('recommends a fuse below the starting cable ampacity', () => {
    for (const a of ACCESSORY_CATALOG) {
      const size = sizeForArea(a.cableStartMm2)
      const amp = deratedAmpacity(size, 'sae_j1128', 30, 1).value
      expect(a.fuseA, `${a.id} on ${size.label}`).toBeLessThanOrEqual(amp)
    }
  })

  it('keeps every accessory inside its connector current rating', () => {
    for (const a of ACCESSORY_CATALOG) {
      const seriesId = connectorSeriesFor(a)
      if (!seriesId) continue
      const series = connectorSeriesById(seriesId)!
      expect(a.runCurrentA, `${a.id} on ${series.label}`).toBeLessThanOrEqual(series.currentRating_a)
    }
  })

  it('classifies charging accessories under the tighter drop budget', () => {
    expect(wireClassFor(accessoryById('dcdc-50a')!)).toBe('charging')
    expect(wireClassFor(accessoryById('buzzer-reverse')!)).toBe('signal')
    expect(wireClassFor(accessoryById('inverter-2000')!)).toBe('power')
  })
})

describe('catalogue against the selection engine', () => {
  it('agrees with the 1.25x rule for the light bar', () => {
    const a = accessoryById('lightbar')!
    const size = sizeForArea(a.cableStartMm2)
    const amp = deratedAmpacity(size, 'sae_j1128', 30, 1).value
    const r = selectFuse({ continuousCurrent_a: a.runCurrentA, wireAmpacity_a: amp })
    expect(r.selected!.rating_a).toBe(a.fuseA)
  })

  it('shows where a vendor recommendation is deliberately above the 1.25x minimum', () => {
    // Redarc specify a 60 A input fuse on the 50 A BCDC; the bare rule would
    // land on 70 A once the cable is big enough. Both protect the cable — the
    // vendor figure is the one to build to, and the tool must not silently
    // overwrite it.
    const a = accessoryById('dcdc-50a')!
    expect(a.fuseA).toBeGreaterThanOrEqual(a.runCurrentA * 1.2)
    const size = sizeForArea(a.cableStartMm2)
    const amp = deratedAmpacity(size, 'sae_j1128', 30, 1).value
    expect(a.fuseA).toBeLessThanOrEqual(amp)
  })
})

describe('nodeFromAccessory', () => {
  it('builds a load node carrying current, inrush and connector', () => {
    const a = accessoryById('cl-actuator')!
    const node = nodeFromAccessory(a, { id: 'cl1', position: { x: 10, y: 20 }, location: 'RH door' })
    expect(node.kind).toBe('load')
    expect(node.load?.continuousCurrent_a).toBe(0.5)
    expect(node.load?.inrushCurrent_a).toBe(8)
    expect(node.connector?.seriesId).toBe('deutsch-dt')
    expect(node.location).toBe('RH door')
  })

  it('leaves the connector off a stud-terminated accessory', () => {
    const node = nodeFromAccessory(accessoryById('inverter-2000')!, {
      id: 'inv',
      position: { x: 0, y: 0 },
    })
    expect(node.connector).toBeUndefined()
    expect(node.load?.continuousCurrent_a).toBe(190)
  })

  it('carries the vendor fuse through as the protection spec', () => {
    const p = protectionFor(accessoryById('inverter-2000')!)
    expect(p.familyId).toBe('anl')
    expect(p.rating_a).toBe(250)
  })
})
