/**
 * The accessory catalogue — the palette the editor drops loads from.
 *
 * Each entry becomes a load node preloaded with its real current, inrush,
 * connector series and recommended fuse, so a design starts from vendor figures
 * rather than from someone's memory.
 */

import accessoryDataRaw from '@data/accessories.json'
import type { LoomNode, ProtectionSpec, WireClass } from './types'

export type AccessoryLoadClass = 'signal' | 'lighting' | 'power' | 'traction'
export type AccessoryConnector =
  | 'DTM'
  | 'DT'
  | 'DTP'
  | 'AndersonSB50'
  | 'AndersonSB120'
  | 'RingLugM6'
  | 'RingLugM8'
export type AccessoryFuseType = 'MINI' | 'ATO' | 'MAXI' | 'MIDI' | 'MEGA_ANL'

export interface Accessory {
  id: string
  name: string
  brand: string
  exampleModel: string
  category: string
  loadClass: AccessoryLoadClass
  /** Continuous draw at ~13.8 V. */
  runCurrentA: number
  inrushA: number | null
  /** Vendor-recommended fuse. Protects the cable and the device. */
  fuseA: number
  fuseType: AccessoryFuseType
  connector: AccessoryConnector
  ways: number
  ground: 'local' | 'return-in-loom' | 'stud'
  /** Starting gauge only — the sizing engine finalises it per run length. */
  cableStartMm2: number
  driveVia: 'direct' | 'relay' | 'module' | null
  ref: string
  notes: string | null
}

const raw = accessoryDataRaw as unknown as {
  meta: {
    title: string
    revision: string
    note: string
    sources: string[]
    connectorMap: Record<string, string | null>
    fuseTypeMap: Record<string, string>
  }
  accessories: Accessory[]
}

export const ACCESSORY_META = raw.meta
export const ACCESSORY_CATALOG: Accessory[] = raw.accessories

export function accessoryById(id: string): Accessory | undefined {
  return ACCESSORY_CATALOG.find((a) => a.id === id)
}

export function accessoryCategories(): string[] {
  return [...new Set(ACCESSORY_CATALOG.map((a) => a.category))].sort()
}

/** Connector series id in connectors.json, or null for a stud/Anderson termination. */
export function connectorSeriesFor(a: Accessory): string | null {
  return raw.meta.connectorMap[a.connector] ?? null
}

/** Fuse family id in fuses.json. */
export function fuseFamilyFor(a: Accessory): string {
  return raw.meta.fuseTypeMap[a.fuseType] ?? 'ato'
}

/** The wire class a run to this accessory should be sized under. */
export function wireClassFor(a: Accessory): WireClass {
  if (a.category === 'Charging') return 'charging'
  if (a.loadClass === 'signal') return 'signal'
  return 'power'
}

export function protectionFor(a: Accessory): ProtectionSpec {
  return { familyId: fuseFamilyFor(a), rating_a: a.fuseA }
}

/** Build a load node from a catalogue entry, ready to drop on the canvas. */
export function nodeFromAccessory(
  a: Accessory,
  opts: { id: string; location?: string; position: { x: number; y: number } },
): LoomNode {
  const series = connectorSeriesFor(a)
  return {
    id: opts.id,
    kind: 'load',
    name: a.name,
    location: opts.location ?? '',
    position: opts.position,
    load: {
      continuousCurrent_a: a.runCurrentA,
      inrushCurrent_a: a.inrushA ?? undefined,
      duty: a.loadClass === 'signal' ? 'momentary' : 'continuous',
      description: `${a.brand} ${a.exampleModel}`.trim(),
    },
    connector: series ? { seriesId: series, ways: a.ways } : undefined,
    notes: [a.notes, a.ref].filter(Boolean).join(' — ') || undefined,
  }
}
