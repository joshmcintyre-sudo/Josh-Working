/**
 * Typed accessors over the reference data in /data.
 *
 * Nothing in the calculation layer hardcodes an ampacity, a resistance or a
 * fuse rating. It all comes from here, and every number carries its source
 * string so a drawing can cite where it came from.
 */

import wireDataRaw from '@data/wire.json'
import connectorDataRaw from '@data/connectors.json'
import fuseDataRaw from '@data/fuses.json'
import type { AmpacityBasis, WireFamily } from './types'

export interface WireSize {
  id: string
  family: WireFamily
  label: string
  awg: string | null
  area_mm2: number
  nearestMetric_mm2: number
  resistance_ohm_per_m: number
  od_mm: Record<string, number>
  mass_g_per_m: number
  ampacity_a: Record<AmpacityBasis, number>
  interpolated: string[]
  source: string
  notes: string | null
}

export interface Insulation {
  id: string
  label: string
  standard: string
  tempRating_c: number
  wallThickness_mm: number
  notes: string
}

export interface FuseFamily {
  id: string
  label: string
  standard: string
  voltageRating_v: number
  interruptRating_a: number
  maxContinuous_a: number
  slowBlow: boolean
  boltDown: boolean
  ratings_a: number[]
  bodyColorByRating?: Record<string, string>
  notes: string
}

export interface FuseHolder {
  id: string
  family: string
  label: string
  partNumber: string
  maxCable_mm2: number
  footprint_mm: { length: number; width: number; height: number }
  mass_g: number
  notes: string
}

export interface ConnectorContact {
  role: string
  type: string
  pn: string | null
  pnConfidence: string
  wireRange_awg?: number[]
  note?: string
}

export interface ConnectorHousing {
  ways: number
  receptaclePn: string
  plugPn: string
  receptacleWedgePn: string
  plugWedgePn: string
  pnConfidence: string
  note?: string
}

export interface ConnectorSeries {
  id: string
  manufacturer: string
  label: string
  contactSize: number | null
  tangWidth_mm?: number
  currentRating_a: number
  wireRange_mm2: number[]
  wireRange_awg: number[]
  sealed: boolean
  ipRating: string
  tempRange_c: number[]
  matingCycles: number
  notes: string
  housings: ConnectorHousing[]
  contacts: ConnectorContact[]
  accessories: { role: string; pn: string | null; pnConfidence: string; note?: string }[]
}

export interface Termination {
  id: string
  label: string
  stud?: string
  wireRange_mm2: number[]
  currentRating_a: number
  insulated?: boolean
  sealed?: boolean
  pn: string | null
  pnConfidence: string
  note?: string
}

export interface ProtectionSleeve {
  id: string
  label: string
  bundleOd_mm: number[]
  tempRange_c?: number[]
}

/* ------------------------------------------------------------------ */

const wireData = wireDataRaw as unknown as {
  meta: {
    title: string
    revision: string
    systemVoltage: number
    standards: string[]
    conductor: {
      material: string
      resistivity_ohm_mm2_per_m_at_20c: number
      temperatureCoefficient_per_c: number
      note: string
    }
    ampacityBases: Record<AmpacityBasis, { label: string; description: string; curveFit: string }>
    bundlingFactors: Record<string, number | string>
    ambientFactors: {
      note: string
      basisAmbient_c: number
      table: { ambient_c: number; factor: number }[]
    }
    voltageDropLimits: Record<string, number | string>
  }
  insulations: Insulation[]
  colorCodes: { note: string; byFunction: Record<string, { color: string; hex: string }> }
  sizes: WireSize[]
}

const connectorData = connectorDataRaw as unknown as {
  meta: {
    title: string
    revision: string
    pnPolicy: { note: string; confidenceLevels: Record<string, string> }
    deratingRule: {
      note: string
      byLoadedWays: { ways: number; factor: number }[]
      ambientAbove85cFactor: number
    }
  }
  series: ConnectorSeries[]
  ringTerminals: Termination[]
  splices: Termination[]
  protection: ProtectionSleeve[]
}

const fuseData = fuseDataRaw as unknown as {
  meta: {
    title: string
    revision: string
    standards: string[]
    selectionRule: {
      description: string
      steps: string[]
      continuousDerateFactor: number
      inrushGuidance: string
      highCurrentThreshold_a: number
      highCurrentNote: string
    }
  }
  families: FuseFamily[]
  holders: FuseHolder[]
}

export const WIRE_META = wireData.meta
export const CONNECTOR_META = connectorData.meta
export const FUSE_META = fuseData.meta

/** All wire sizes, ascending by conductor area. */
export const WIRE_SIZES: WireSize[] = [...wireData.sizes].sort((a, b) => a.area_mm2 - b.area_mm2)

export const INSULATIONS: Insulation[] = wireData.insulations
export const COLOR_CODES = wireData.colorCodes.byFunction
export const CONNECTOR_SERIES: ConnectorSeries[] = connectorData.series
export const RING_TERMINALS: Termination[] = connectorData.ringTerminals
export const SPLICES: Termination[] = connectorData.splices
export const SLEEVING: ProtectionSleeve[] = connectorData.protection
export const FUSE_FAMILIES: FuseFamily[] = fuseData.families
export const FUSE_HOLDERS: FuseHolder[] = fuseData.holders

/** Voltage-drop budget as a fraction of system voltage, by wire class. */
export const DROP_LIMITS = wireData.meta.voltageDropLimits as unknown as Record<string, number>

/**
 * Per-contact derate for a connector with `loadedWays` cavities carrying
 * current. Interpolated between the tabulated points and clamped at the ends.
 */
export function contactDerating(loadedWays: number): number {
  const table = CONNECTOR_META.deratingRule.byLoadedWays
  const first = table[0]
  const last = table[table.length - 1]
  if (!first || !last) return 1
  if (loadedWays <= first.ways) return first.factor
  if (loadedWays >= last.ways) return last.factor
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i]!
    const hi = table[i + 1]!
    if (loadedWays >= lo.ways && loadedWays <= hi.ways) {
      const t = (loadedWays - lo.ways) / (hi.ways - lo.ways)
      return lo.factor + t * (hi.factor - lo.factor)
    }
  }
  return 1
}

/**
 * Does a standard fuse rating actually exist between these bounds? A window
 * that is non-empty in amps can still contain no real fuse, which is the
 * failure the sizing pass has to catch before it settles on a conductor.
 */
export function standardFuseExistsBetween(min_a: number, max_a: number, familyIds?: string[]): boolean {
  const families = familyIds?.length
    ? FUSE_FAMILIES.filter((f) => familyIds.includes(f.id))
    : FUSE_FAMILIES.filter((f) => !f.id.startsWith('breaker_'))
  return families.some((f) => f.ratings_a.some((r) => r >= min_a && r <= max_a))
}

export function wireSizeById(id: string): WireSize | undefined {
  return WIRE_SIZES.find((s) => s.id === id)
}

export function sizesForFamily(family: WireFamily | 'any'): WireSize[] {
  if (family === 'any') return WIRE_SIZES
  return WIRE_SIZES.filter((s) => s.family === family)
}

export function insulationById(id: string): Insulation | undefined {
  return INSULATIONS.find((i) => i.id === id)
}

export function fuseFamilyById(id: string): FuseFamily | undefined {
  return FUSE_FAMILIES.find((f) => f.id === id)
}

export function connectorSeriesById(id: string): ConnectorSeries | undefined {
  return CONNECTOR_SERIES.find((c) => c.id === id)
}

/**
 * Bundling derate. Conductors in a taped bundle cannot shed heat into free
 * air, and this is the derate most commonly missed on a hand-built loom.
 */
export function bundlingFactor(count: number): number {
  const f = wireData.meta.bundlingFactors as Record<string, number>
  if (count <= 1) return f.single ?? 1
  if (count <= 3) return f.bundle_2_3 ?? 0.8
  if (count <= 6) return f.bundle_4_6 ?? 0.7
  if (count <= 15) return f.bundle_7_15 ?? 0.65
  return f.bundle_16_plus ?? 0.5
}

/**
 * Ambient derate, linearly interpolated between the published table points and
 * clamped at the ends.
 */
export function ambientFactor(ambient_c: number): number {
  const table = wireData.meta.ambientFactors.table
  const first = table[0]
  const last = table[table.length - 1]
  if (!first || !last) return 1
  if (ambient_c <= first.ambient_c) return first.factor
  if (ambient_c >= last.ambient_c) return last.factor
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i]!
    const hi = table[i + 1]!
    if (ambient_c >= lo.ambient_c && ambient_c <= hi.ambient_c) {
      const t = (ambient_c - lo.ambient_c) / (hi.ambient_c - lo.ambient_c)
      return lo.factor + t * (hi.factor - lo.factor)
    }
  }
  return 1
}

/**
 * Conductor resistance corrected for temperature. Copper gains about 0.393 %
 * resistance per °C, so a conductor sitting at its 105 °C rating carries
 * roughly a third more drop than the 20 °C table value.
 */
export function resistanceAt(size: WireSize, conductorTemp_c: number): number {
  const alpha = wireData.meta.conductor.temperatureCoefficient_per_c
  return size.resistance_ohm_per_m * (1 + alpha * (conductorTemp_c - 20))
}

/** Derated ampacity for a size under a given basis, ambient and bundle count. */
export function deratedAmpacity(
  size: WireSize,
  basis: AmpacityBasis,
  ambient_c: number,
  bundleCount: number,
): { value: number; base: number; ambient: number; bundle: number } {
  const base = size.ampacity_a[basis]
  const ambient = ambientFactor(ambient_c)
  const bundle = bundlingFactor(bundleCount)
  return { value: base * ambient * bundle, base, ambient, bundle }
}
