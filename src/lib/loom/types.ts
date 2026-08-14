/**
 * Core loom data model.
 *
 * A loom is a directed graph. Nodes are physical things that current arrives at
 * or leaves from; edges are the wire runs between them. Everything the
 * engineering calculations need is on the model — nothing is inferred from
 * naming conventions.
 */

export type NodeKind = 'source' | 'load' | 'splice' | 'ground' | 'connector'

export type Duty = 'continuous' | 'intermittent' | 'momentary'

/**
 * Wire class drives the voltage-drop budget. Power circuits get 3 % because
 * lamps and motors lose output fast below spec; signal circuits get 10 %
 * because they carry almost no current and the receiver tolerates it.
 */
export type WireClass = 'power' | 'signal' | 'charging' | 'ground' | 'starter'

export type WireFamily = 'awg' | 'metric'

export type AmpacityBasis = 'sae_j1128' | 'as_nzs_3808'

/** How the circuit's return current gets back to the source. */
export type ReturnPath =
  /** Return is through the vehicle body; drop is computed for this conductor only. */
  | 'chassis'
  /** Return is a separate wire that exists as its own edge in this loom. */
  | 'modeled'
  /** Return is a wire of the same length that is NOT drawn; drop is doubled. */
  | 'implied_return'

export interface LoadSpec {
  /** Steady-state draw once the load has settled. */
  continuousCurrent_a: number
  /** Peak draw at switch-on. Motors and solenoids are typically 3-8x continuous. */
  inrushCurrent_a?: number
  /** How long the inrush lasts. Drives fuse family choice. */
  inrushDuration_ms?: number
  duty: Duty
  /** For intermittent duty, the fraction of the time the load is actually on. */
  dutyCyclePct?: number
  description?: string
}

export interface SourceSpec {
  nominalVoltage_v: number
  /** Sustained current the source can deliver. Used for the total-load check. */
  capacity_a: number
  batteryCapacity_ah?: number
  description?: string
}

export interface GroundSpec {
  /** 'chassis' = bolted body/chassis stud. 'battery' = direct to battery negative. */
  method: 'chassis' | 'battery' | 'busbar'
  /** Bolt size at the ground point, e.g. "M8". */
  stud?: string
}

export interface ConnectorSpec {
  /** Series id from data/connectors.json, e.g. "deutsch-dt". */
  seriesId: string
  ways: number
  /** Cavity assignments, keyed by cavity number. */
  cavities?: Record<string, string>
}

export interface SpliceSpec {
  /** Splice id from data/connectors.json. */
  spliceId?: string
  method: 'crimp' | 'solder_sleeve' | 'ultrasonic_weld' | 'busbar'
}

export interface ProtectionSpec {
  /** Family id from data/fuses.json, e.g. "ato", "anl". */
  familyId: string
  /** Rating in amps. Omit to let the calculator choose. */
  rating_a?: number
  holderId?: string
}

export interface LoomNode {
  id: string
  kind: NodeKind
  name: string
  /** Physical location on the vehicle, e.g. "RH chassis rail, fwd of axle". */
  location: string
  /** Schematic canvas position, arbitrary units. */
  position: { x: number; y: number }
  /**
   * Formboard position in millimetres from the board origin. This is what the
   * 1:1 drawing is plotted from. Falls back to a scaled schematic position.
   */
  formboardPosition?: { x: number; y: number }
  load?: LoadSpec
  source?: SourceSpec
  ground?: GroundSpec
  connector?: ConnectorSpec
  splice?: SpliceSpec
  /** Protection device fitted AT this node, on its outgoing edges. */
  protection?: ProtectionSpec
  notes?: string
}

export interface LoomEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  /** Human circuit reference, e.g. "C-104". Appears on the drawing and labels. */
  circuitId: string
  label?: string
  /** Physical run length in millimetres, including service loops. */
  length_mm: number
  class: WireClass
  returnPath: ReturnPath
  /** Insulation id from data/wire.json. Defaults to GXL. */
  insulationId?: string
  /** Force a specific size instead of letting the calculator choose. */
  gaugeOverrideId?: string
  /** Restrict sizing to one family. Defaults to the loom setting. */
  family?: WireFamily
  /** Override the derived current, for loads the graph cannot infer. */
  currentOverride_a?: number
  colorOverride?: string
  /** Number of conductors sharing this bundle, including this one. */
  bundleCount?: number
  /** Ambient temperature this run passes through, in °C. */
  ambient_c?: number
  /** Formboard routing polyline in millimetres. Straight line if absent. */
  routing?: { x: number; y: number }[]
  /** Protection device in series with this run, at the source end. */
  protection?: ProtectionSpec
  notes?: string
}

export interface LoomSettings {
  systemVoltage_v: number
  ampacityBasis: AmpacityBasis
  defaultFamily: WireFamily
  defaultAmbient_c: number
  defaultInsulationId: string
  /**
   * Smallest size the shop will hand-crimp. Anything the calculation would
   * choose below this is raised to it, and reported as minimum_size limited.
   */
  minimumSizeId: string
  /** Extra length added to every run for service loops and dress, in mm. */
  serviceLoop_mm: number
}

export interface Loom {
  id: string
  name: string
  description?: string
  revision: string
  settings: LoomSettings
  nodes: LoomNode[]
  edges: LoomEdge[]
  /** Formboard sheet size in mm, used to paginate the 1:1 drawing. */
  formboard?: { width_mm: number; height_mm: number }
}

export const DEFAULT_SETTINGS: LoomSettings = {
  systemVoltage_v: 12,
  ampacityBasis: 'sae_j1128',
  defaultFamily: 'awg',
  defaultAmbient_c: 30,
  defaultInsulationId: 'gxl',
  minimumSizeId: 'awg-20',
  serviceLoop_mm: 0,
}
