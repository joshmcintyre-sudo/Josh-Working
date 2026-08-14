import { describe, expect, it } from 'vitest'
import { selectFuse } from './fuse-selection'

describe('selectFuse — the rule', () => {
  it('picks the smallest standard rating at or above 1.25x the load', () => {
    // 1.25 x 10 = 12.5, so the 15 A blade is the first that qualifies.
    const r = selectFuse({ continuousCurrent_a: 10, wireAmpacity_a: 19 })
    expect(r.ok).toBe(true)
    expect(r.minimumRating_a).toBeCloseTo(12.5, 6)
    expect(r.selected?.rating_a).toBe(15)
  })

  it('never selects a rating above the conductor ampacity', () => {
    const r = selectFuse({ continuousCurrent_a: 20, wireAmpacity_a: 27 })
    expect(r.selected!.rating_a).toBeLessThanOrEqual(27)
    expect(r.selected!.rating_a).toBeGreaterThanOrEqual(25)
  })

  it('fails when the wire is too small for any legal fuse', () => {
    // Needs at least 62.5 A but the conductor is only good for 50 A.
    const r = selectFuse({ continuousCurrent_a: 50, wireAmpacity_a: 50 })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/too small to protect/)
  })

  it('rounds tiny loads up to the smallest available rating', () => {
    const r = selectFuse({ continuousCurrent_a: 0.5, wireAmpacity_a: 8.5 })
    expect(r.selected!.rating_a).toBeGreaterThanOrEqual(0.625)
    expect(r.selected!.rating_a).toBeLessThanOrEqual(8.5)
  })

  it('rejects a zero load', () => {
    const r = selectFuse({ continuousCurrent_a: 0, wireAmpacity_a: 19 })
    expect(r.ok).toBe(false)
  })
})

describe('selectFuse — family choice', () => {
  it('prefers a serviceable blade fuse below the high-current threshold', () => {
    const r = selectFuse({ continuousCurrent_a: 15, wireAmpacity_a: 35 })
    expect(r.selected!.boltDown).toBe(false)
    expect(r.requiresBoltDown).toBe(false)
  })

  it('forces a bolt-down fuse on an inverter feed', () => {
    // 2000 W at 12 V on 1/0 AWG.
    const r = selectFuse({ continuousCurrent_a: 170, wireAmpacity_a: 245 })
    expect(r.requiresBoltDown).toBe(true)
    expect(r.selected!.boltDown).toBe(true)
    expect(r.selected!.rating_a).toBe(225)
    expect(r.warnings.join(' ')).toMatch(/blade-fuse threshold/)
  })

  it('forces a bolt-down fuse on a 50 A DC-DC feed', () => {
    const r = selectFuse({ continuousCurrent_a: 50, wireAmpacity_a: 70, preferredFamilyId: 'midi' })
    expect(r.selected!.familyId).toBe('midi')
    expect(r.selected!.rating_a).toBe(70)
  })

  it('honours a preferred family when a rating fits', () => {
    const r = selectFuse({ continuousCurrent_a: 100, wireAmpacity_a: 200, preferredFamilyId: 'anl' })
    expect(r.selected!.familyId).toBe('anl')
    expect(r.selected!.rating_a).toBe(125)
  })

  it('falls back with a warning when the preferred family has no fitting rating', () => {
    // MIDI starts at 30 A; a 2 A load on a small conductor cannot use one.
    const r = selectFuse({ continuousCurrent_a: 2, wireAmpacity_a: 8.5, preferredFamilyId: 'midi' })
    expect(r.ok).toBe(true)
    expect(r.selected!.familyId).not.toBe('midi')
    expect(r.warnings.join(' ')).toMatch(/falling back/)
  })

  it('never auto-selects a circuit breaker', () => {
    const r = selectFuse({ continuousCurrent_a: 20, wireAmpacity_a: 35 })
    expect(r.selected!.familyId).not.toMatch(/^breaker_/)
    for (const alt of r.alternatives) expect(alt.familyId).not.toMatch(/^breaker_/)
  })

  it('can be restricted to families the shop stocks', () => {
    const r = selectFuse({
      continuousCurrent_a: 10,
      wireAmpacity_a: 19,
      allowedFamilies: ['mini'],
    })
    expect(r.selected!.familyId).toBe('mini')
  })

  it('reports its reasoning in words', () => {
    const r = selectFuse({ continuousCurrent_a: 10, wireAmpacity_a: 19 })
    expect(r.rationale).toMatch(/1\.25 x 10 A/)
    expect(r.rationale).toMatch(/19\.0 A derated ampacity/)
  })
})

describe('selectFuse — inrush', () => {
  it('warns when a long motor surge sits on a fast-acting fuse', () => {
    // Four central-locking actuators: 5 A holding, 40 A for 250 ms.
    const r = selectFuse({
      continuousCurrent_a: 5,
      wireAmpacity_a: 8.5,
      inrushCurrent_a: 40,
      inrushDuration_ms: 250,
    })
    expect(r.selected!.rating_a).toBe(7.5)
    expect(r.warnings.join(' ')).toMatch(/nuisance blowing/)
  })

  it('stays quiet about a short capacitive surge', () => {
    // LED light bar: 30 A for 20 ms is well inside any fuse's I²t.
    const r = selectFuse({
      continuousCurrent_a: 10,
      wireAmpacity_a: 19,
      inrushCurrent_a: 30,
      inrushDuration_ms: 20,
    })
    expect(r.warnings.join(' ')).not.toMatch(/nuisance blowing/)
  })

  it('does not warn when the chosen family is already slow-blow', () => {
    const r = selectFuse({
      continuousCurrent_a: 50,
      wireAmpacity_a: 70,
      inrushCurrent_a: 300,
      inrushDuration_ms: 300,
      preferredFamilyId: 'midi',
    })
    expect(r.selected!.slowBlow).toBe(true)
    expect(r.warnings.join(' ')).not.toMatch(/nuisance blowing/)
  })
})
