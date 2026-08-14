import { describe, expect, it } from 'vitest'
import { dropLimitFor, loopFactorFor, sizeWire, type SizingInput } from './wire-sizing'
import { wireSizeById } from './data'

const base: SizingInput = {
  current_a: 10,
  length_mm: 1000,
  class: 'power',
  returnPath: 'chassis',
  systemVoltage_v: 12,
  basis: 'sae_j1128',
  family: 'awg',
  ambient_c: 30,
  bundleCount: 1,
  minimumSizeId: 'awg-20',
}

describe('voltage drop budgets', () => {
  it('gives power 3 % and signal 10 %', () => {
    expect(dropLimitFor('power')).toBe(0.03)
    expect(dropLimitFor('signal')).toBe(0.1)
  })

  it('holds a ground return to the power budget', () => {
    expect(dropLimitFor('ground')).toBe(dropLimitFor('power'))
  })

  it('gives a charging run a tighter budget than a general power run', () => {
    expect(dropLimitFor('charging')).toBeLessThan(dropLimitFor('power'))
  })
})

describe('loop factor', () => {
  it('counts one conductor for chassis and separately drawn returns', () => {
    expect(loopFactorFor('chassis')).toBe(1)
    expect(loopFactorFor('modeled')).toBe(1)
  })

  it('doubles the drop when the return exists but is not drawn', () => {
    expect(loopFactorFor('implied_return')).toBe(2)
  })
})

describe('sizeWire — which constraint binds', () => {
  it('is ampacity limited on a short high-current run', () => {
    // 60 A over 500 mm: drop would allow 14 AWG, ampacity demands 8 AWG.
    const r = sizeWire({ ...base, current_a: 60, length_mm: 500 })
    expect(r.ok).toBe(true)
    expect(r.size?.id).toBe('awg-8')
    expect(r.limitingConstraint).toBe('ampacity')
    expect(r.dropDrivenSize?.area_mm2).toBeLessThan(r.size!.area_mm2)
  })

  it('is voltage-drop limited on a long low-current run', () => {
    // 10 A over 3 m: 18 AWG carries the current, but only 14 AWG holds 3 %.
    const r = sizeWire({ ...base, current_a: 10, length_mm: 3000 })
    expect(r.size?.id).toBe('awg-14')
    expect(r.limitingConstraint).toBe('voltage_drop')
    expect(r.ampacityDrivenSize?.id).toBe('awg-18')
    expect(r.voltageDropPct).toBeLessThanOrEqual(3)
  })

  it('reports both when the two constraints land on the same size', () => {
    // At 1100 mm, 18 AWG is simultaneously the first size that carries 15 A and
            // the first that holds the 3 % budget.
    const r = sizeWire({ ...base, current_a: 15, length_mm: 1100 })
    expect(r.limitingConstraint).toBe('both')
    expect(r.ampacityDrivenSize?.id).toBe(r.size?.id)
    expect(r.dropDrivenSize?.id).toBe(r.size?.id)
  })

  it('raises tiny circuits to the shop minimum gauge', () => {
    const r = sizeWire({ ...base, current_a: 0.5, length_mm: 800, class: 'signal' })
    expect(r.size?.id).toBe('awg-20')
    expect(r.limitingConstraint).toBe('minimum_size')
  })
})

describe('sizeWire — the numbers', () => {
  it('computes drop as I x R x L for a single conductor', () => {
    const r = sizeWire({ ...base, current_a: 10, length_mm: 3000, gaugeOverrideId: 'awg-14' })
    const size = wireSizeById('awg-14')!
    const expected = 10 * size.resistance_ohm_per_m * 3
    expect(r.voltageDrop_v).toBeCloseTo(expected, 6)
    expect(r.voltageDropPct).toBeCloseTo((expected / 12) * 100, 6)
    expect(r.limitingConstraint).toBe('override')
  })

  it('doubles the drop for an implied return of equal length', () => {
    const single = sizeWire({ ...base, length_mm: 2000, gaugeOverrideId: 'awg-14' })
    const looped = sizeWire({
      ...base,
      length_mm: 2000,
      gaugeOverrideId: 'awg-14',
      returnPath: 'implied_return',
    })
    expect(looped.voltageDrop_v).toBeCloseTo(single.voltageDrop_v * 2, 9)
  })

  it('corrects resistance upward for a hot conductor', () => {
    const cold = sizeWire({ ...base, gaugeOverrideId: 'awg-16', conductorTemp_c: 20 })
    const hot = sizeWire({ ...base, gaugeOverrideId: 'awg-16', conductorTemp_c: 105 })
    expect(hot.voltageDrop_v).toBeGreaterThan(cold.voltageDrop_v * 1.3)
  })

  it('upsizes when the run is bundled', () => {
    const single = sizeWire({ ...base, current_a: 20, length_mm: 400 })
    const bundled = sizeWire({ ...base, current_a: 20, length_mm: 400, bundleCount: 10 })
    expect(single.size!.area_mm2).toBeLessThan(bundled.size!.area_mm2)
    expect(bundled.derating.bundle).toBeLessThan(1)
  })

  it('upsizes when the run passes through a hot engine bay', () => {
    const cool = sizeWire({ ...base, current_a: 30, length_mm: 400, ambient_c: 30 })
    const hot = sizeWire({ ...base, current_a: 30, length_mm: 400, ambient_c: 85 })
    expect(hot.size!.area_mm2).toBeGreaterThan(cool.size!.area_mm2)
  })

  it('reports ampacity utilisation against the derated figure', () => {
    const r = sizeWire({ ...base, current_a: 19, length_mm: 200, gaugeOverrideId: 'awg-16' })
    expect(r.deratedAmpacity_a).toBeCloseTo(19, 6)
    expect(r.ampacityUtilisationPct).toBeCloseTo(100, 6)
  })
})

describe('sizeWire — fusibility', () => {
  it('leaves room for a 1.25x fuse on a protected run', () => {
    // 50 A: ampacity alone allows 10 AWG (50 A), but a 62.5 A fuse would not fit
    // under it, so the conductor has to go to 8 AWG (70 A).
    const unprotected = sizeWire({ ...base, current_a: 50, length_mm: 500 })
    const protectedRun = sizeWire({ ...base, current_a: 50, length_mm: 500, requireFusible: true })
    expect(unprotected.size?.id).toBe('awg-10')
    expect(protectedRun.size?.id).toBe('awg-8')
    expect(protectedRun.limitingConstraint).toBe('fusibility')
  })

  it('does not apply the fusibility rule to unfused runs', () => {
    const r = sizeWire({ ...base, current_a: 50, length_mm: 500, class: 'ground' })
    expect(r.size?.id).toBe('awg-10')
  })

  it('errors when a manually forced gauge leaves no legal fuse', () => {
    const r = sizeWire({
      ...base,
      current_a: 50,
      length_mm: 500,
      requireFusible: true,
      gaugeOverrideId: 'awg-10',
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/No standard fuse rating fits in that window/)
  })
})

describe('sizeWire — failure and reporting', () => {
  it('fails cleanly when nothing in the family can do the job', () => {
    const r = sizeWire({ ...base, current_a: 600, length_mm: 8000 })
    expect(r.ok).toBe(false)
    expect(r.size).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('rejects a zero-length run', () => {
    const r = sizeWire({ ...base, length_mm: 0 })
    expect(r.errors.join(' ')).toMatch(/greater than zero/)
  })

  it('warns when a run sits above 90 % of its derated ampacity', () => {
    const r = sizeWire({ ...base, current_a: 18, length_mm: 200, gaugeOverrideId: 'awg-16' })
    expect(r.warnings.join(' ')).toMatch(/derated ampacity/)
  })

  it('warns when a chassis return carries serious current', () => {
    const r = sizeWire({ ...base, current_a: 60, length_mm: 500, returnPath: 'chassis' })
    expect(r.warnings.join(' ')).toMatch(/Chassis return/)
  })

  it('warns when the ampacity figure it used was interpolated', () => {
    // Every metric row is interpolated on the SAE basis.
    const r = sizeWire({ ...base, family: 'metric', minimumSizeId: 'mm2-0-5', current_a: 20, length_mm: 500 })
    expect(r.warnings.join(' ')).toMatch(/interpolated/)
  })

  it('states the reason for the chosen size in words', () => {
    const r = sizeWire({ ...base, current_a: 10, length_mm: 3000 })
    expect(r.rationale).toMatch(/voltage-drop limited/)
    expect(r.rationale).toContain('14 AWG')
  })

  it('sizes in metric when asked', () => {
    const r = sizeWire({ ...base, current_a: 25, length_mm: 800, family: 'metric', minimumSizeId: 'mm2-0-5' })
    expect(r.size?.family).toBe('metric')
    expect(r.size?.label).toMatch(/mm²/)
  })

  it('is more conservative on the AS/NZS basis than on SAE', () => {
    const sae = sizeWire({ ...base, current_a: 90, length_mm: 400, basis: 'sae_j1128' })
    const nzs = sizeWire({ ...base, current_a: 90, length_mm: 400, basis: 'as_nzs_3808' })
    expect(nzs.size!.area_mm2).toBeGreaterThanOrEqual(sae.size!.area_mm2)
  })
})
