/** Row shapes matching supabase/migrations/0001_init.sql. */

export interface LoomRow {
  id: string
  owner_id: string
  name: string
  description: string | null
  revision: string
  settings: unknown
  formboard: unknown
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface LoomNodeRow {
  id?: string
  loom_id: string
  node_key: string
  kind: string
  name: string
  location: string
  position: unknown
  formboard_position: unknown
  load: unknown
  source: unknown
  ground: unknown
  connector: unknown
  splice: unknown
  protection: unknown
  notes: string | null
}

export interface LoomEdgeRow {
  id?: string
  loom_id: string
  edge_key: string
  from_node_key: string
  to_node_key: string
  circuit_id: string
  label: string | null
  length_mm: number
  class: string
  return_path: string
  insulation_id: string | null
  gauge_override_id: string | null
  family: string | null
  current_override_a: number | null
  color_override: string | null
  bundle_count: number | null
  ambient_c: number | null
  routing: unknown
  protection: unknown
  notes: string | null
  segment_keys: unknown
  length_from_routing: boolean | null
  tail_from_mm: number | null
  tail_to_mm: number | null
}

export interface LoomSegmentRow {
  id?: string
  loom_id: string
  segment_key: string
  from_node_key: string
  to_node_key: string
  length_mm: number
  routing: unknown
  sleeving_id: string | null
  ties: unknown
  label: string | null
  notes: string | null
}

export interface LoomWireRow {
  id?: string
  loom_id: string
  revision: string
  edge_key: string
  circuit_id: string
  current_a: number
  length_mm: number
  wire_size_id: string
  wire_label: string
  area_mm2: number
  insulation_id: string | null
  color: string | null
  voltage_drop_v: number
  voltage_drop_pct: number
  drop_limit_pct: number
  derated_ampacity_a: number
  limiting_constraint: string
  ampacity_basis: string
  fuse_family_id: string | null
  fuse_rating_a: number | null
  rationale: string
  data_revisions: unknown
  released_at?: string
}

export interface AccessoryRow {
  id: string
  owner_id: string
  catalog_key: string
  name: string
  brand: string
  example_model: string
  category: string
  load_class: string
  run_current_a: number
  inrush_a: number | null
  inrush_ms: number | null
  fuse_a: number | null
  fuse_type: string | null
  connector: string | null
  ways: number
  ground: string
  cable_start_mm2: number | null
  drive_via: string | null
  ref: string
  notes: string | null
  is_stock: boolean
  created_at?: string
  updated_at?: string
}
