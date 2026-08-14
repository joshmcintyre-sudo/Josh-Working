/**
 * Persistence interface.
 *
 * Two implementations: Supabase for real use, and a local store so the editor
 * runs and is testable without credentials. The UI only ever sees this
 * interface, so nothing in the app knows which one it is talking to.
 */

import type { Accessory } from '~/lib/loom/accessories'
import type { Loom } from '~/lib/loom/types'
import type { LoomWireRow } from './schema'

export interface LoomSummary {
  id: string
  name: string
  description?: string
  revision: string
  nodeCount: number
  edgeCount: number
  updatedAt: string
}

export interface LoomRepository {
  readonly kind: 'supabase' | 'local'

  listLooms(): Promise<LoomSummary[]>
  getLoom(id: string): Promise<Loom | null>
  createLoom(loom: Loom): Promise<Loom>
  /** Replaces the loom's nodes and edges wholesale. Simple and race-free. */
  saveLoom(loom: Loom): Promise<Loom>
  deleteLoom(id: string): Promise<void>

  /** Freeze the calculated schedule for a revision. */
  releaseWires(loomId: string, revision: string, rows: LoomWireRow[]): Promise<void>
  getRelease(loomId: string, revision: string): Promise<LoomWireRow[]>
  listReleases(loomId: string): Promise<{ revision: string; releasedAt: string; count: number }[]>

  listAccessories(): Promise<Accessory[]>
  upsertAccessory(a: Accessory): Promise<Accessory>
  deleteAccessory(catalogKey: string): Promise<void>
  /** Restore the shipped catalogue, discarding edits. */
  resetAccessories(): Promise<Accessory[]>
}
