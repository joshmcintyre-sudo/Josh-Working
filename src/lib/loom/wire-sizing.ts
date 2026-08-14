/**
 * Wire sizing.
 *
 * The rule, stated once so the drawing can cite it:
 *
 *   Choose the smallest standard size where ALL of
 *     (a) circuit current <= derated ampacity of the conductor,
 *     (b) voltage drop over the run <= the budget for the wire's class
 *         (3 % power, 10 % signal) at the system voltage, and
 *     (c) on a protected run, 1.25 x current <= derated ampacity, so that a
 *         legal fuse exists between the load and the conductor's rating.
 *
 * Each constraint is evaluated independently so the result can say which one
 * actually forced the size. On short high-current runs it is ampacity; on long
 * runs it is nearly always voltage drop, and knowing which is which is the
 * difference between a sensible loom and an expensive one.
 */

import {
  DROP_LIMITS,
  deratedAmpacity,
  resistanceAt,
  sizesForFamily,
  standardFuseExistsBetween,
  wireSizeById,
  type WireSize,
} from './data'
import type { AmpacityBasis, ReturnPath, WireClass, WireFamily } from './types'

export type LimitingConstraint =
  | 'ampacity'
  | 'voltage_drop'
  | 'both'
  | 'fusibility'
  | 'minimum_size'
  | 'override'

/**
 * A protected run has a third, easily missed constraint. The fuse must be at
 * least 1.25x the load AND at or below the conductor's ampacity. If the wire is
 * sized so that its ampacity lands between the load and 1.25x the load, no legal
 * fuse exists and the two rules contradict each other. The wire has to be
 * upsized until a fuse fits between them.
 */
export const FUSIBILITY_FACTOR = 1.25

export interface SizingInput {
  current_a: number
  length_mm: number
  class: WireClass
  returnPath: ReturnPath
  systemVoltage_v: number
  basis: AmpacityBasis
  family: WireFamily | 'any'
  ambient_c: number
  bundleCount: number
  /** Conductor temperature used for the resistance correction. */
  conductorTemp_c?: number
  /** Fraction of system voltage allowed as drop. Defaults to the class budget. */
  dropLimit?: number
  /** Smallest size the shop will build with. */
  minimumSizeId?: string
  /** Force a size and report against it rather than choosing. */
  gaugeOverrideId?: string
  /**
   * Set when the run is fused. Requires derated ampacity >= 1.25 x current so a
   * legal fuse exists. Ground returns and unprotected runs leave this off.
   */
  requireFusible?: boolean
  /** Restrict the fusibility check to the families the loom actually uses. */
  fuseFamilies?: string[]
  /**
   * Conductor must be rated at or above this, whatever the load. Set when a
   * specific fuse rating has already been chosen — the wire has to survive the
   * fuse, not just the load.
   */
  minimumAmpacity_a?: number
}

export interface SizingCandidate {
  size: WireSize
  deratedAmpacity_a: number
  voltageDrop_v: number
  voltageDropPct: number
  passesAmpacity: boolean
  passesDrop: boolean
  passesFusibility: boolean
}

export interface SizingResult {
  ok: boolean
  size: WireSize | null
  current_a: number
  length_mm: number
  /** 1 for chassis or separately modelled returns, 2 when the return is implied. */
  loopFactor: number
  conductorTemp_c: number
  resistance_ohm_per_m: number
  circuitResistance_ohm: number
  voltageDrop_v: number
  voltageDropPct: number
  dropLimitPct: number
  deratedAmpacity_a: number
  baseAmpacity_a: number
  ampacityUtilisationPct: number
  derating: { ambient: number; bundle: number; combined: number }
  limitingConstraint: LimitingConstraint
  /** Smallest size that satisfies ampacity alone. */
  ampacityDrivenSize: WireSize | null
  /** Smallest size that satisfies voltage drop alone. */
  dropDrivenSize: WireSize | null
  /** Smallest size on which a legal fuse exists, when the run is protected. */
  fusibilityDrivenSize: WireSize | null
  basis: AmpacityBasis
  /** Plain-English statement of why this size was chosen, for the drawing. */
  rationale: string
  warnings: string[]
  errors: string[]
}

/** Voltage-drop budget for a wire class, as a fraction of system voltage. */
export function dropLimitFor(cls: WireClass): number {
  const byClass: Record<WireClass, string> = {
    power: 'power',
    signal: 'signal',
    charging: 'charging',
    starter: 'starter',
    // A ground return is part of a power circuit and shares its budget.
    ground: 'power',
  }
  const key = byClass[cls]
  const v = DROP_LIMITS[key]
  return typeof v === 'number' ? v : 0.03
}

export function loopFactorFor(returnPath: ReturnPath): number {
  // 'chassis' — the body is the return and its resistance is negligible next to
  // the conductor, so only this run contributes.
  // 'modeled' — the return wire is its own edge and gets its own drop figure.
  // 'implied_return' — the return exists physically but is not drawn, so it has
  // to be accounted for here. Assume equal length.
  return returnPath === 'implied_return' ? 2 : 1
}

/**
 * A protected conductor has to be big enough that a real fuse fits between the
 * load and its own rating — and big enough for any rating already specified.
 */
function passesFusibility(input: SizingInput, ampacity_a: number): boolean {
  if (input.minimumAmpacity_a !== undefined && ampacity_a < input.minimumAmpacity_a) return false
  if (!input.requireFusible) return true
  const min = input.current_a * FUSIBILITY_FACTOR
  if (ampacity_a < min) return false
  return standardFuseExistsBetween(min, ampacity_a, input.fuseFamilies)
}

function evaluate(size: WireSize, input: SizingInput, conductorTemp_c: number): SizingCandidate {
  const loop = loopFactorFor(input.returnPath)
  const r = resistanceAt(size, conductorTemp_c)
  const length_m = input.length_mm / 1000
  const drop_v = input.current_a * r * length_m * loop
  const dropPct = drop_v / input.systemVoltage_v
  const amp = deratedAmpacity(size, input.basis, input.ambient_c, input.bundleCount)
  const limit = input.dropLimit ?? dropLimitFor(input.class)
  return {
    size,
    deratedAmpacity_a: amp.value,
    voltageDrop_v: drop_v,
    voltageDropPct: dropPct * 100,
    passesAmpacity: input.current_a <= amp.value,
    passesDrop: dropPct <= limit,
    passesFusibility: passesFusibility(input, amp.value),
  }
}

export function sizeWire(input: SizingInput): SizingResult {
  const conductorTemp_c = input.conductorTemp_c ?? 20
  const dropLimit = input.dropLimit ?? dropLimitFor(input.class)
  const warnings: string[] = []
  const errors: string[] = []

  const pool = sizesForFamily(input.family)
  if (pool.length === 0) {
    errors.push(`No wire sizes available for family "${input.family}".`)
  }

  if (input.current_a < 0) errors.push('Current must not be negative.')
  if (input.length_mm <= 0) errors.push('Run length must be greater than zero.')

  const candidates = pool.map((s) => evaluate(s, input, conductorTemp_c))
  const ampacityDriven = candidates.find((c) => c.passesAmpacity)?.size ?? null
  const dropDriven = candidates.find((c) => c.passesDrop)?.size ?? null
  const fusibilityDriven = candidates.find((c) => c.passesFusibility)?.size ?? null

  // Apply the shop's minimum practical size, if it is in the chosen family.
  const minimum = input.minimumSizeId ? wireSizeById(input.minimumSizeId) : undefined
  const minimumInPool = minimum && pool.some((s) => s.id === minimum.id) ? minimum : undefined

  let chosen: WireSize | null = null
  let limiting: LimitingConstraint = 'ampacity'

  if (input.gaugeOverrideId) {
    const forced = wireSizeById(input.gaugeOverrideId)
    if (!forced) {
      errors.push(`Unknown wire size id "${input.gaugeOverrideId}".`)
    } else {
      chosen = forced
      limiting = 'override'
    }
  } else {
    const byAll = candidates.find((c) => c.passesAmpacity && c.passesDrop && c.passesFusibility)
    if (!byAll) {
      errors.push(
        `No size in the ${input.family} range satisfies ${input.current_a} A over ` +
          `${input.length_mm} mm within a ${(dropLimit * 100).toFixed(1)} % drop budget. ` +
          `Shorten the run, split the load, or raise the drop budget.`,
      )
    } else {
      chosen = byAll.size
      const ampBinds = ampacityDriven?.id === chosen.id
      const dropBinds = dropDriven?.id === chosen.id
      const fuseBinds =
        (input.requireFusible || input.minimumAmpacity_a !== undefined) &&
        fusibilityDriven?.id === chosen.id
      if (ampBinds && dropBinds) limiting = 'both'
      else if (fuseBinds && !ampBinds && !dropBinds) limiting = 'fusibility'
      else if (ampBinds) limiting = 'ampacity'
      else limiting = 'voltage_drop'
    }

    if (chosen && minimumInPool && minimumInPool.area_mm2 > chosen.area_mm2) {
      chosen = minimumInPool
      limiting = 'minimum_size'
    }
  }

  if (!chosen) {
    return {
      ok: false,
      size: null,
      current_a: input.current_a,
      length_mm: input.length_mm,
      loopFactor: loopFactorFor(input.returnPath),
      conductorTemp_c,
      resistance_ohm_per_m: 0,
      circuitResistance_ohm: 0,
      voltageDrop_v: 0,
      voltageDropPct: 0,
      dropLimitPct: dropLimit * 100,
      deratedAmpacity_a: 0,
      baseAmpacity_a: 0,
      ampacityUtilisationPct: 0,
      derating: { ambient: 1, bundle: 1, combined: 1 },
      limitingConstraint: 'ampacity',
      ampacityDrivenSize: ampacityDriven,
      dropDrivenSize: dropDriven,
      fusibilityDrivenSize: fusibilityDriven,
      basis: input.basis,
      rationale: 'No size satisfies the constraints.',
      warnings,
      errors,
    }
  }

  const final = evaluate(chosen, input, conductorTemp_c)
  const amp = deratedAmpacity(chosen, input.basis, input.ambient_c, input.bundleCount)
  const loop = loopFactorFor(input.returnPath)
  const r = resistanceAt(chosen, conductorTemp_c)

  if (!final.passesAmpacity) {
    errors.push(
      `${chosen.label} is rated ${amp.value.toFixed(1)} A after derating but the run carries ` +
        `${input.current_a} A.`,
    )
  }
  if (!final.passesFusibility) {
    if (input.minimumAmpacity_a !== undefined && amp.value < input.minimumAmpacity_a) {
      errors.push(
        `${chosen.label} is rated ${amp.value.toFixed(1)} A but is protected by a ` +
          `${input.minimumAmpacity_a} A fuse. The wire will fail before the fuse does — upsize it.`,
      )
    } else {
      errors.push(
        `${chosen.label} is rated ${amp.value.toFixed(1)} A but a fuse for a ${input.current_a} A ` +
          `load must be at least ${(input.current_a * FUSIBILITY_FACTOR).toFixed(1)} A. ` +
          `No standard fuse rating fits in that window — upsize the conductor.`,
      )
    }
  }
  if (!final.passesDrop) {
    errors.push(
      `${chosen.label} drops ${final.voltageDropPct.toFixed(2)} % over ${input.length_mm} mm, ` +
        `over the ${(dropLimit * 100).toFixed(1)} % budget.`,
    )
  }
  if (final.passesAmpacity && input.current_a > amp.value * 0.9) {
    warnings.push(
      `Running at ${((input.current_a / amp.value) * 100).toFixed(0)} % of derated ampacity — ` +
        `no headroom for a future load on this run.`,
    )
  }
  if (chosen.interpolated.includes(input.basis)) {
    warnings.push(
      `Ampacity for ${chosen.label} on the ${input.basis} basis is interpolated, not published. ` +
        `Confirm before releasing a production build.`,
    )
  }
  if (input.returnPath === 'chassis' && input.current_a > 30) {
    warnings.push(
      `Chassis return at ${input.current_a} A. Body joints add resistance that is not modelled ` +
        `here — run a dedicated negative cable above roughly 30 A.`,
    )
  }

  const rationale = buildRationale(chosen, limiting, final, amp.value, dropLimit, input)

  return {
    ok: errors.length === 0,
    size: chosen,
    current_a: input.current_a,
    length_mm: input.length_mm,
    loopFactor: loop,
    conductorTemp_c,
    resistance_ohm_per_m: r,
    circuitResistance_ohm: r * (input.length_mm / 1000) * loop,
    voltageDrop_v: final.voltageDrop_v,
    voltageDropPct: final.voltageDropPct,
    dropLimitPct: dropLimit * 100,
    deratedAmpacity_a: amp.value,
    baseAmpacity_a: amp.base,
    ampacityUtilisationPct: amp.value > 0 ? (input.current_a / amp.value) * 100 : 0,
    derating: { ambient: amp.ambient, bundle: amp.bundle, combined: amp.ambient * amp.bundle },
    limitingConstraint: limiting,
    ampacityDrivenSize: ampacityDriven,
    dropDrivenSize: dropDriven,
    fusibilityDrivenSize: fusibilityDriven,
    basis: input.basis,
    rationale,
    warnings,
    errors,
  }
}

function buildRationale(
  size: WireSize,
  limiting: LimitingConstraint,
  final: SizingCandidate,
  ampacity_a: number,
  dropLimit: number,
  input: SizingInput,
): string {
  const drop = `${final.voltageDropPct.toFixed(2)} % of ${(dropLimit * 100).toFixed(1)} % allowed`
  const amps = `${input.current_a} A of ${ampacity_a.toFixed(1)} A derated`
  switch (limiting) {
    case 'ampacity':
      return `${size.label} — ampacity limited (${amps}); drop is comfortable at ${drop}.`
    case 'voltage_drop':
      return `${size.label} — voltage-drop limited over ${input.length_mm} mm (${drop}); ampacity would allow a smaller size.`
    case 'both':
      return `${size.label} — both constraints bind at this size (${amps}, ${drop}).`
    case 'fusibility':
      return `${size.label} — upsized so a fuse fits: it must be at or above 1.25 x ${input.current_a} A and at or below the conductor's ${ampacity_a.toFixed(1)} A. Ampacity and drop alone would allow smaller.`
    case 'minimum_size':
      return `${size.label} — raised to the shop minimum size; the calculation alone would allow smaller (${amps}, ${drop}).`
    case 'override':
      return `${size.label} — manually specified. Checks: ${amps}, ${drop}.`
  }
}
