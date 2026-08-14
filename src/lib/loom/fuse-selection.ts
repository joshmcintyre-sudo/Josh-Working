/**
 * Fuse selection.
 *
 *   minimum rating = 1.25 x continuous current
 *   chosen rating  = smallest standard rating >= minimum
 *   and it must be <= the derated ampacity of the wire it protects,
 *   otherwise the wire is acting as the fuse.
 *
 * The 1.25 factor is headroom: a fuse held at exactly its rating fatigues and
 * eventually opens for no reason. The upper bound is the whole point of the
 * device — a fuse protects the cable, not the load on the end of it.
 */

import { FUSE_FAMILIES, FUSE_META, fuseFamilyById, type FuseFamily } from './data'

export interface FuseSelectionInput {
  continuousCurrent_a: number
  /** Derated ampacity of the conductor this fuse protects. */
  wireAmpacity_a: number
  inrushCurrent_a?: number
  inrushDuration_ms?: number
  /** Restrict to these family ids. Defaults to all. */
  allowedFamilies?: string[]
  /** Force a family, e.g. because the loom already uses an ANL block. */
  preferredFamilyId?: string
  /**
   * A rating already chosen by the designer or the accessory vendor. It is
   * validated rather than replaced — a vendor's fuse kit is usually a
   * deliberate choice above the bare 1.25x minimum.
   */
  fixedRating_a?: number
}

export interface FuseOption {
  familyId: string
  familyLabel: string
  rating_a: number
  boltDown: boolean
  slowBlow: boolean
  headroomOverLoad: number
  marginToWireAmpacity_a: number
}

export interface FuseSelectionResult {
  ok: boolean
  selected: FuseOption | null
  minimumRating_a: number
  maximumRating_a: number
  alternatives: FuseOption[]
  /** True when the load is above the blade-fuse threshold and needs a bolt-down. */
  requiresBoltDown: boolean
  rationale: string
  warnings: string[]
  errors: string[]
}

const DERATE = FUSE_META.selectionRule.continuousDerateFactor
const HIGH_CURRENT_THRESHOLD = FUSE_META.selectionRule.highCurrentThreshold_a

function optionsFrom(family: FuseFamily, min: number, max: number, load: number): FuseOption[] {
  return family.ratings_a
    .filter((r) => r >= min && r <= max && r <= family.maxContinuous_a)
    .map((r) => ({
      familyId: family.id,
      familyLabel: family.label,
      rating_a: r,
      boltDown: family.boltDown,
      slowBlow: family.slowBlow,
      headroomOverLoad: load > 0 ? r / load : Infinity,
      marginToWireAmpacity_a: max - r,
    }))
}

export function selectFuse(input: FuseSelectionInput): FuseSelectionResult {
  const warnings: string[] = []
  const errors: string[] = []
  const load = input.continuousCurrent_a
  const minimum = load * DERATE
  const maximum = input.wireAmpacity_a
  const requiresBoltDown = load > HIGH_CURRENT_THRESHOLD

  if (load <= 0) {
    errors.push('Continuous current must be greater than zero to size a fuse.')
  }
  if (maximum < minimum) {
    errors.push(
      `Wire is too small to protect: it needs a fuse of at least ${minimum.toFixed(1)} A ` +
        `(1.25 x ${load} A) but its derated ampacity is only ${maximum.toFixed(1)} A. ` +
        `Upsize the conductor.`,
    )
  }

  let families = FUSE_FAMILIES
  if (input.allowedFamilies?.length) {
    families = families.filter((f) => input.allowedFamilies!.includes(f.id))
  }
  // Circuit breakers are a deliberate choice, never an automatic one.
  const autoFamilies = families.filter((f) => !f.id.startsWith('breaker_'))
  if (requiresBoltDown) {
    const boltDown = autoFamilies.filter((f) => f.boltDown)
    if (boltDown.length) {
      warnings.push(
        `${load} A is above the ${HIGH_CURRENT_THRESHOLD} A blade-fuse threshold. ` +
          FUSE_META.selectionRule.highCurrentNote,
      )
    }
  }

  const all = autoFamilies.flatMap((f) => optionsFrom(f, minimum, maximum, load))

  const preferred = input.preferredFamilyId
  let pool = all
  if (preferred) {
    const inPreferred = all.filter((o) => o.familyId === preferred)
    if (inPreferred.length) {
      pool = inPreferred
    } else if (fuseFamilyById(preferred)) {
      warnings.push(
        `No rating in the ${fuseFamilyById(preferred)!.label} family fits between ` +
          `${minimum.toFixed(1)} A and ${maximum.toFixed(1)} A — falling back to other families.`,
      )
    } else {
      errors.push(`Unknown fuse family "${preferred}".`)
    }
  } else if (requiresBoltDown) {
    const boltDown = all.filter((o) => o.boltDown)
    if (boltDown.length) pool = boltDown
  } else {
    // Below the threshold, prefer a plug-in blade fuse — serviceable roadside.
    const blade = all.filter((o) => !o.boltDown)
    if (blade.length) pool = blade
  }

  // Smallest rating wins; ties broken toward the family with the most headroom
  // to the wire's ampacity, i.e. the safest for the cable.
  const sorted = [...pool].sort(
    (a, b) => a.rating_a - b.rating_a || b.marginToWireAmpacity_a - a.marginToWireAmpacity_a,
  )

  let selected: FuseOption | null = sorted[0] ?? null
  if (input.fixedRating_a !== undefined) {
    const family = fuseFamilyById(preferred ?? '') ?? FUSE_FAMILIES.find((f) => f.ratings_a.includes(input.fixedRating_a!))
    if (!family) {
      errors.push(`${input.fixedRating_a} A is not a standard rating in any known fuse family.`)
    } else {
      if (!family.ratings_a.includes(input.fixedRating_a)) {
        errors.push(
          `${input.fixedRating_a} A is not a standard rating in the ${family.label} family.`,
        )
      }
      selected = {
        familyId: family.id,
        familyLabel: family.label,
        rating_a: input.fixedRating_a,
        boltDown: family.boltDown,
        slowBlow: family.slowBlow,
        headroomOverLoad: load > 0 ? input.fixedRating_a / load : Infinity,
        marginToWireAmpacity_a: maximum - input.fixedRating_a,
      }
      if (input.fixedRating_a > maximum) {
        errors.push(
          `${input.fixedRating_a} A fuse on a conductor rated ${maximum.toFixed(1)} A — ` +
            `the wire will fail before the fuse does.`,
        )
      }
      if (input.fixedRating_a < minimum) {
        warnings.push(
          `${input.fixedRating_a} A is below 1.25 x the ${load} A load (${minimum.toFixed(1)} A) — ` +
            `expect nuisance blowing.`,
        )
      }
    }
  }

  if (!selected && errors.length === 0) {
    errors.push(
      `No standard fuse rating falls between ${minimum.toFixed(1)} A and ` +
        `${maximum.toFixed(1)} A in the allowed families.`,
    )
  }

  if (selected && input.inrushCurrent_a) {
    const ratio = input.inrushCurrent_a / selected.rating_a
    const duration = input.inrushDuration_ms ?? 0
    if (ratio > 4 && duration > 100 && !selected.slowBlow) {
      warnings.push(
        `Inrush of ${input.inrushCurrent_a} A for ${duration} ms is ${ratio.toFixed(1)}x the ` +
          `${selected.rating_a} A rating on a fast-acting fuse — expect nuisance blowing. ` +
          `Use a slow-blow (MIDI) or a Type I breaker.`,
      )
    } else if (ratio > 10) {
      warnings.push(
        `Inrush of ${input.inrushCurrent_a} A is ${ratio.toFixed(1)}x the fuse rating. ` +
          FUSE_META.selectionRule.inrushGuidance,
      )
    }
  }

  const rationale = selected
    ? input.fixedRating_a !== undefined
      ? `${selected.rating_a} A ${selected.familyLabel} — specified. Rule check: at or above ` +
        `1.25 x ${load} A (${minimum.toFixed(1)} A) and at or below the conductor's ` +
        `${maximum.toFixed(1)} A derated ampacity.`
      : `${selected.rating_a} A ${selected.familyLabel} — smallest standard rating at or above ` +
        `1.25 x ${load} A (${minimum.toFixed(1)} A) and at or below the conductor's ` +
        `${maximum.toFixed(1)} A derated ampacity.`
    : `No fuse selected. Required window was ${minimum.toFixed(1)} A to ${maximum.toFixed(1)} A.`

  return {
    ok: errors.length === 0 && selected !== null,
    selected,
    minimumRating_a: minimum,
    maximumRating_a: maximum,
    alternatives: sorted.slice(1, 6),
    requiresBoltDown,
    rationale,
    warnings,
    errors,
  }
}
