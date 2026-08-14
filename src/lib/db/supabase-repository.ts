/**
 * Supabase repository.
 *
 * Save is a whole-loom replace: delete the loom's nodes and edges, insert the
 * new set. A loom is small (tens of rows) and this avoids an entire class of
 * partial-update bug where an edge survives the node it pointed at. The
 * composite foreign key in the schema means the insert order matters — nodes
 * first, always.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACCESSORY_CATALOG, type Accessory } from '~/lib/loom/accessories'
import type { Loom } from '~/lib/loom/types'
import { accessoryFromRow, accessoryToRow, edgeToRow, loomFromRows, nodeToRow } from './mappers'
import type { LoomRepository, LoomSummary } from './repository'
import type { AccessoryRow, LoomEdgeRow, LoomNodeRow, LoomRow, LoomWireRow } from './schema'

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  if (res.data === null) throw new Error(`${what}: no data returned`)
  return res.data
}

export class SupabaseLoomRepository implements LoomRepository {
  readonly kind = 'supabase' as const

  constructor(
    private readonly db: SupabaseClient,
    private readonly ownerId: string,
  ) {}

  async listLooms(): Promise<LoomSummary[]> {
    const looms = unwrap(
      await this.db
        .from('looms')
        .select('id, name, description, revision, updated_at')
        .is('archived_at', null)
        .order('updated_at', { ascending: false }),
      'list looms',
    ) as Pick<LoomRow, 'id' | 'name' | 'description' | 'revision' | 'updated_at'>[]

    // One extra round trip for counts beats N queries or an unindexed view.
    const counts = unwrap(
      await this.db.from('loom_nodes').select('loom_id'),
      'count nodes',
    ) as { loom_id: string }[]
    const edgeCounts = unwrap(
      await this.db.from('loom_edges').select('loom_id'),
      'count edges',
    ) as { loom_id: string }[]

    const tally = (rows: { loom_id: string }[]) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.loom_id] = (acc[r.loom_id] ?? 0) + 1
        return acc
      }, {})
    const n = tally(counts)
    const e = tally(edgeCounts)

    return looms.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description ?? undefined,
      revision: l.revision,
      nodeCount: n[l.id] ?? 0,
      edgeCount: e[l.id] ?? 0,
      updatedAt: l.updated_at,
    }))
  }

  async getLoom(id: string): Promise<Loom | null> {
    const { data, error } = await this.db.from('looms').select('*').eq('id', id).maybeSingle()
    if (error) throw new Error(`get loom: ${error.message}`)
    if (!data) return null
    const nodes = unwrap(
      await this.db.from('loom_nodes').select('*').eq('loom_id', id),
      'get nodes',
    ) as LoomNodeRow[]
    const edges = unwrap(
      await this.db.from('loom_edges').select('*').eq('loom_id', id),
      'get edges',
    ) as LoomEdgeRow[]
    return loomFromRows(data as LoomRow, nodes, edges)
  }

  async createLoom(loom: Loom): Promise<Loom> {
    const inserted = unwrap(
      await this.db
        .from('looms')
        .insert({
          id: loom.id,
          owner_id: this.ownerId,
          name: loom.name,
          description: loom.description ?? null,
          revision: loom.revision,
          settings: loom.settings,
          formboard: loom.formboard ?? null,
        })
        .select()
        .single(),
      'create loom',
    ) as LoomRow
    await this.writeGraph(inserted.id, loom)
    return { ...loom, id: inserted.id }
  }

  async saveLoom(loom: Loom): Promise<Loom> {
    const { error } = await this.db
      .from('looms')
      .update({
        name: loom.name,
        description: loom.description ?? null,
        revision: loom.revision,
        settings: loom.settings,
        formboard: loom.formboard ?? null,
      })
      .eq('id', loom.id)
    if (error) throw new Error(`save loom: ${error.message}`)
    await this.writeGraph(loom.id, loom)
    return loom
  }

  /** Edges are deleted first and inserted last — they depend on the nodes. */
  private async writeGraph(loomId: string, loom: Loom): Promise<void> {
    for (const [table, msg] of [
      ['loom_edges', 'clear edges'],
      ['loom_nodes', 'clear nodes'],
    ] as const) {
      const { error } = await this.db.from(table).delete().eq('loom_id', loomId)
      if (error) throw new Error(`${msg}: ${error.message}`)
    }
    if (loom.nodes.length) {
      const { error } = await this.db
        .from('loom_nodes')
        .insert(loom.nodes.map((n) => nodeToRow(loomId, n)))
      if (error) throw new Error(`write nodes: ${error.message}`)
    }
    if (loom.edges.length) {
      const { error } = await this.db
        .from('loom_edges')
        .insert(loom.edges.map((e) => edgeToRow(loomId, e)))
      if (error) throw new Error(`write edges: ${error.message}`)
    }
  }

  async deleteLoom(id: string): Promise<void> {
    const { error } = await this.db.from('looms').delete().eq('id', id)
    if (error) throw new Error(`delete loom: ${error.message}`)
  }

  async releaseWires(loomId: string, revision: string, rows: LoomWireRow[]): Promise<void> {
    const { error: del } = await this.db
      .from('loom_wires')
      .delete()
      .eq('loom_id', loomId)
      .eq('revision', revision)
    if (del) throw new Error(`clear release: ${del.message}`)
    if (!rows.length) return
    const { error } = await this.db.from('loom_wires').insert(rows)
    if (error) throw new Error(`release wires: ${error.message}`)
  }

  async getRelease(loomId: string, revision: string): Promise<LoomWireRow[]> {
    return unwrap(
      await this.db
        .from('loom_wires')
        .select('*')
        .eq('loom_id', loomId)
        .eq('revision', revision)
        .order('circuit_id'),
      'get release',
    ) as LoomWireRow[]
  }

  async listReleases(loomId: string) {
    const rows = unwrap(
      await this.db
        .from('loom_wires')
        .select('revision, released_at')
        .eq('loom_id', loomId)
        .order('released_at', { ascending: false }),
      'list releases',
    ) as { revision: string; released_at: string }[]
    const byRevision = new Map<string, { revision: string; releasedAt: string; count: number }>()
    for (const r of rows) {
      const existing = byRevision.get(r.revision)
      if (existing) existing.count++
      else byRevision.set(r.revision, { revision: r.revision, releasedAt: r.released_at, count: 1 })
    }
    return [...byRevision.values()]
  }

  async listAccessories(): Promise<Accessory[]> {
    const rows = unwrap(
      await this.db.from('accessories').select('*').order('category').order('name'),
      'list accessories',
    ) as AccessoryRow[]
    if (rows.length === 0) return this.resetAccessories()
    return rows.map(accessoryFromRow)
  }

  async upsertAccessory(a: Accessory): Promise<Accessory> {
    const row = accessoryToRow(this.ownerId, a, { isStock: false })
    const { id: _ignored, ...payload } = row
    const { error } = await this.db
      .from('accessories')
      .upsert(payload, { onConflict: 'owner_id,catalog_key' })
    if (error) throw new Error(`save accessory: ${error.message}`)
    return a
  }

  async deleteAccessory(catalogKey: string): Promise<void> {
    const { error } = await this.db
      .from('accessories')
      .delete()
      .eq('owner_id', this.ownerId)
      .eq('catalog_key', catalogKey)
    if (error) throw new Error(`delete accessory: ${error.message}`)
  }

  async resetAccessories(): Promise<Accessory[]> {
    const { error: del } = await this.db
      .from('accessories')
      .delete()
      .eq('owner_id', this.ownerId)
    if (del) throw new Error(`reset accessories: ${del.message}`)
    const payload = ACCESSORY_CATALOG.map((a) => {
      const { id: _ignored, ...row } = accessoryToRow(this.ownerId, a, { isStock: true })
      return row
    })
    const { error } = await this.db.from('accessories').insert(payload)
    if (error) throw new Error(`seed accessories: ${error.message}`)
    return structuredClone(ACCESSORY_CATALOG)
  }
}
