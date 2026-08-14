import { beforeEach, describe, expect, it } from 'vitest'
import { analyseLoom } from '~/lib/loom/analysis'
import { DEMO_LOOM } from '~/lib/loom/demo-loom'
import { ACCESSORY_CATALOG } from '~/lib/loom/accessories'
import type { Loom } from '~/lib/loom/types'
import { LocalLoomRepository, __resetLocalStore } from './local-repository'
import {
  accessoryFromRow,
  accessoryToRow,
  currentDataRevisions,
  edgeFromRow,
  edgeToRow,
  loomFromRows,
  nodeFromRow,
  nodeToRow,
  wireRowsFromAnalysis,
} from './mappers'

describe('row mapping round-trips', () => {
  it('preserves every node through a save and load', () => {
    for (const node of DEMO_LOOM.nodes) {
      expect(nodeFromRow(nodeToRow(DEMO_LOOM.id, node))).toEqual(node)
    }
  })

  it('preserves every edge through a save and load', () => {
    for (const edge of DEMO_LOOM.edges) {
      expect(edgeFromRow(edgeToRow(DEMO_LOOM.id, edge))).toEqual(edge)
    }
  })

  it('reassembles a whole loom from its rows', () => {
    const rebuilt = loomFromRows(
      {
        id: DEMO_LOOM.id,
        owner_id: 'owner',
        name: DEMO_LOOM.name,
        description: DEMO_LOOM.description ?? null,
        revision: DEMO_LOOM.revision,
        settings: DEMO_LOOM.settings,
        formboard: DEMO_LOOM.formboard ?? null,
        archived_at: null,
        created_at: '',
        updated_at: '',
      },
      DEMO_LOOM.nodes.map((n) => nodeToRow(DEMO_LOOM.id, n)),
      DEMO_LOOM.edges.map((e) => edgeToRow(DEMO_LOOM.id, e)),
    )
    expect(rebuilt).toEqual(DEMO_LOOM)
  })

  it('produces an identical analysis after a round-trip', () => {
    const rebuilt = loomFromRows(
      {
        id: DEMO_LOOM.id,
        owner_id: 'owner',
        name: DEMO_LOOM.name,
        description: DEMO_LOOM.description ?? null,
        revision: DEMO_LOOM.revision,
        settings: DEMO_LOOM.settings,
        formboard: DEMO_LOOM.formboard ?? null,
        archived_at: null,
        created_at: '',
        updated_at: '',
      },
      DEMO_LOOM.nodes.map((n) => nodeToRow(DEMO_LOOM.id, n)),
      DEMO_LOOM.edges.map((e) => edgeToRow(DEMO_LOOM.id, e)),
    )
    const before = analyseLoom(DEMO_LOOM)
    const after = analyseLoom(rebuilt)
    expect(after.totals).toEqual(before.totals)
    expect(after.issues).toEqual(before.issues)
  })

  it('preserves an accessory through a save and load', () => {
    for (const a of ACCESSORY_CATALOG) {
      expect(accessoryFromRow(accessoryToRow('owner', a))).toEqual(a)
    }
  })
})

describe('wire release snapshot', () => {
  const analysis = analyseLoom(DEMO_LOOM)
  const rows = wireRowsFromAnalysis(DEMO_LOOM.id, 'A', analysis)

  it('freezes one row per sized run', () => {
    expect(rows.length).toBe(analysis.edges.filter((e) => e.sizing.size).length)
  })

  it('captures the size, the drop and the constraint that drove it', () => {
    const inv = rows.find((r) => r.edge_key === 'e-inv-feed')!
    expect(inv.wire_size_id).toBe('awg-3-0')
    expect(inv.limiting_constraint).toBe('fusibility')
    expect(inv.fuse_rating_a).toBe(225)
    expect(inv.voltage_drop_pct).toBeGreaterThan(0)
    expect(inv.rationale.length).toBeGreaterThan(0)
  })

  it('stamps the reference data revisions it was computed against', () => {
    const revisions = currentDataRevisions()
    expect(Object.keys(revisions).sort()).toEqual(['accessories', 'connectors', 'fuses', 'wire'])
    for (const r of rows) expect(r.data_revisions).toEqual(revisions)
  })
})

describe('local repository', () => {
  let repo: LocalLoomRepository

  beforeEach(() => {
    __resetLocalStore()
    repo = new LocalLoomRepository()
  })

  it('starts seeded with the demo loom', async () => {
    const looms = await repo.listLooms()
    expect(looms.map((l) => l.id)).toContain(DEMO_LOOM.id)
    expect(looms[0]!.nodeCount).toBeGreaterThan(0)
  })

  it('round-trips a loom through save and load', async () => {
    const loom: Loom = { ...structuredClone(DEMO_LOOM), id: 'copy', name: 'Copy' }
    await repo.createLoom(loom)
    expect(await repo.getLoom('copy')).toEqual(loom)
  })

  it('refuses to create over an existing id', async () => {
    await expect(repo.createLoom(DEMO_LOOM)).rejects.toThrow(/already exists/)
  })

  it('persists edits', async () => {
    const loom = (await repo.getLoom(DEMO_LOOM.id))!
    loom.name = 'Renamed'
    loom.edges[0]!.length_mm = 1500
    await repo.saveLoom(loom)
    const reloaded = (await repo.getLoom(DEMO_LOOM.id))!
    expect(reloaded.name).toBe('Renamed')
    expect(reloaded.edges[0]!.length_mm).toBe(1500)
  })

  it('does not alias stored state with the caller object', async () => {
    const loom = (await repo.getLoom(DEMO_LOOM.id))!
    await repo.saveLoom(loom)
    loom.name = 'Mutated after save'
    expect((await repo.getLoom(DEMO_LOOM.id))!.name).not.toBe('Mutated after save')
  })

  it('deletes a loom and its releases', async () => {
    await repo.releaseWires(DEMO_LOOM.id, 'A', wireRowsFromAnalysis(DEMO_LOOM.id, 'A', analyseLoom(DEMO_LOOM)))
    await repo.deleteLoom(DEMO_LOOM.id)
    expect(await repo.getLoom(DEMO_LOOM.id)).toBeNull()
    expect(await repo.getRelease(DEMO_LOOM.id, 'A')).toEqual([])
  })

  it('stores and lists frozen releases', async () => {
    const rows = wireRowsFromAnalysis(DEMO_LOOM.id, 'A', analyseLoom(DEMO_LOOM))
    await repo.releaseWires(DEMO_LOOM.id, 'A', rows)
    expect((await repo.getRelease(DEMO_LOOM.id, 'A')).length).toBe(rows.length)
    const releases = await repo.listReleases(DEMO_LOOM.id)
    expect(releases).toHaveLength(1)
    expect(releases[0]!.revision).toBe('A')
    expect(releases[0]!.count).toBe(rows.length)
  })

  it('keeps a release stable when the loom afterwards changes', async () => {
    const rows = wireRowsFromAnalysis(DEMO_LOOM.id, 'A', analyseLoom(DEMO_LOOM))
    await repo.releaseWires(DEMO_LOOM.id, 'A', rows)
    const loom = (await repo.getLoom(DEMO_LOOM.id))!
    loom.edges.find((e) => e.id === 'e-inv-feed')!.length_mm = 6000
    await repo.saveLoom(loom)
    const frozen = await repo.getRelease(DEMO_LOOM.id, 'A')
    expect(frozen.find((r) => r.edge_key === 'e-inv-feed')!.length_mm).toBe(1200)
  })
})

describe('accessory catalogue editing', () => {
  let repo: LocalLoomRepository

  beforeEach(() => {
    __resetLocalStore()
    repo = new LocalLoomRepository()
  })

  it('seeds from the shipped catalogue on first use', async () => {
    const list = await repo.listAccessories()
    expect(list.map((a) => a.id)).toEqual(ACCESSORY_CATALOG.map((a) => a.id))
  })

  it('edits a current rating and keeps it', async () => {
    const list = await repo.listAccessories()
    const strobe = { ...list.find((a) => a.id === 'strobe')!, runCurrentA: 1 }
    await repo.upsertAccessory(strobe)
    const reloaded = await repo.listAccessories()
    expect(reloaded.find((a) => a.id === 'strobe')!.runCurrentA).toBe(1)
  })

  it('adds a new accessory', async () => {
    await repo.listAccessories()
    await repo.upsertAccessory({
      id: 'winch-12000',
      name: 'Winch 12000 lb',
      brand: 'Runva',
      exampleModel: 'EWX12000',
      category: 'Traction',
      loadClass: 'traction',
      runCurrentA: 320,
      inrushA: 450,
      fuseA: 400,
      fuseType: 'MEGA_ANL',
      connector: 'RingLugM8',
      ways: 2,
      ground: 'stud',
      cableStartMm2: 70,
      driveVia: 'direct',
      ref: '',
      notes: null,
    })
    const list = await repo.listAccessories()
    expect(list.find((a) => a.id === 'winch-12000')?.runCurrentA).toBe(320)
  })

  it('deletes an accessory', async () => {
    await repo.listAccessories()
    await repo.deleteAccessory('beacon')
    expect((await repo.listAccessories()).find((a) => a.id === 'beacon')).toBeUndefined()
  })

  it('resets edits back to the shipped catalogue', async () => {
    const list = await repo.listAccessories()
    await repo.upsertAccessory({ ...list[0]!, runCurrentA: 999 })
    const reset = await repo.resetAccessories()
    expect(reset).toEqual(ACCESSORY_CATALOG)
  })
})
