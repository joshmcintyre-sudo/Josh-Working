/**
 * Local repository.
 *
 * Backed by localStorage in the browser and a plain Map on the server or under
 * test. Used when Supabase credentials are absent, so the editor is fully
 * usable — and the whole persistence path is testable — without a project.
 */

import { ACCESSORY_CATALOG, type Accessory } from '~/lib/loom/accessories'
import { DEMO_LOOM } from '~/lib/loom/demo-loom'
import type { Loom } from '~/lib/loom/types'
import type { LoomRepository, LoomSummary } from './repository'
import type { LoomWireRow } from './schema'

const KEY = 'loomwright.store.v1'

interface Store {
  looms: Record<string, { loom: Loom; updatedAt: string }>
  releases: Record<string, LoomWireRow[]>
  accessories: Accessory[] | null
}

const emptyStore = (): Store => ({ looms: {}, releases: {}, accessories: null })

function seeded(): Store {
  const s = emptyStore()
  s.looms[DEMO_LOOM.id] = { loom: structuredClone(DEMO_LOOM), updatedAt: new Date(0).toISOString() }
  return s
}

/** In-memory fallback for SSR and tests, where localStorage does not exist. */
const memory = new Map<string, string>()

function read(): Store {
  const raw =
    typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : (memory.get(KEY) ?? null)
  if (!raw) return seeded()
  try {
    const parsed = JSON.parse(raw) as Store
    return { ...emptyStore(), ...parsed }
  } catch {
    // A corrupted store should not brick the app; start clean rather than throw.
    return seeded()
  }
}

function write(s: Store): void {
  const raw = JSON.stringify(s)
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, raw)
  else memory.set(KEY, raw)
}

export class LocalLoomRepository implements LoomRepository {
  readonly kind = 'local' as const

  async listLooms(): Promise<LoomSummary[]> {
    const s = read()
    return Object.values(s.looms)
      .map(({ loom, updatedAt }) => ({
        id: loom.id,
        name: loom.name,
        description: loom.description,
        revision: loom.revision,
        nodeCount: loom.nodes.length,
        edgeCount: loom.edges.length,
        updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getLoom(id: string): Promise<Loom | null> {
    return read().looms[id]?.loom ?? null
  }

  async createLoom(loom: Loom): Promise<Loom> {
    const s = read()
    if (s.looms[loom.id]) throw new Error(`A loom with id "${loom.id}" already exists.`)
    s.looms[loom.id] = { loom: structuredClone(loom), updatedAt: new Date().toISOString() }
    write(s)
    return loom
  }

  async saveLoom(loom: Loom): Promise<Loom> {
    const s = read()
    s.looms[loom.id] = { loom: structuredClone(loom), updatedAt: new Date().toISOString() }
    write(s)
    return loom
  }

  async deleteLoom(id: string): Promise<void> {
    const s = read()
    delete s.looms[id]
    for (const k of Object.keys(s.releases)) if (k.startsWith(`${id}::`)) delete s.releases[k]
    write(s)
  }

  async releaseWires(loomId: string, revision: string, rows: LoomWireRow[]): Promise<void> {
    const s = read()
    s.releases[`${loomId}::${revision}`] = rows.map((r) => ({
      ...r,
      released_at: new Date().toISOString(),
    }))
    write(s)
  }

  async getRelease(loomId: string, revision: string): Promise<LoomWireRow[]> {
    return read().releases[`${loomId}::${revision}`] ?? []
  }

  async listReleases(loomId: string) {
    const s = read()
    return Object.entries(s.releases)
      .filter(([k]) => k.startsWith(`${loomId}::`))
      .map(([k, rows]) => ({
        revision: k.slice(loomId.length + 2),
        releasedAt: rows[0]?.released_at ?? '',
        count: rows.length,
      }))
      .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt))
  }

  async listAccessories(): Promise<Accessory[]> {
    const s = read()
    if (s.accessories) return s.accessories
    // First use: seed from the shipped catalogue.
    s.accessories = structuredClone(ACCESSORY_CATALOG)
    write(s)
    return s.accessories
  }

  async upsertAccessory(a: Accessory): Promise<Accessory> {
    const s = read()
    const list = s.accessories ?? structuredClone(ACCESSORY_CATALOG)
    const i = list.findIndex((x) => x.id === a.id)
    if (i >= 0) list[i] = a
    else list.push(a)
    s.accessories = list
    write(s)
    return a
  }

  async deleteAccessory(catalogKey: string): Promise<void> {
    const s = read()
    s.accessories = (s.accessories ?? structuredClone(ACCESSORY_CATALOG)).filter(
      (x) => x.id !== catalogKey,
    )
    write(s)
  }

  async resetAccessories(): Promise<Accessory[]> {
    const s = read()
    s.accessories = structuredClone(ACCESSORY_CATALOG)
    write(s)
    return s.accessories
  }
}

/** Test helper: wipe the store so each case starts from the seeded state. */
export function __resetLocalStore(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  memory.delete(KEY)
}
