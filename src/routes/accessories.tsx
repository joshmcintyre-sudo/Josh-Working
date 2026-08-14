import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { getRepository } from '~/lib/db'
import {
  ACCESSORY_CATALOG,
  connectorSeriesFor,
  fuseFamilyFor,
  type Accessory,
  type AccessoryConnector,
  type AccessoryFuseType,
  type AccessoryLoadClass,
} from '~/lib/loom/accessories'
import {
  connectorSeriesById,
  deratedAmpacity,
  fuseFamilyById,
  WIRE_SIZES,
} from '~/lib/loom/data'
import { Badge, Button, EmptyState, Field, Input, NumberInput, Select, Textarea } from '~/components/ui'
import { amps } from '~/lib/utils'

export const Route = createFileRoute('/accessories')({ component: AccessoryEditor })

const LOAD_CLASSES: AccessoryLoadClass[] = ['signal', 'lighting', 'power', 'traction']
const FUSE_TYPES: AccessoryFuseType[] = ['MINI', 'ATO', 'MAXI', 'MIDI', 'MEGA_ANL']
const CONNECTORS: AccessoryConnector[] = [
  'DTM',
  'DT',
  'DTP',
  'AndersonSB50',
  'AndersonSB120',
  'RingLugM6',
  'RingLugM8',
]

/**
 * Sanity checks run live as ratings are edited, using the same data the sizing
 * engine uses. Editing a catalogue entry into an impossible combination should
 * be caught here, not three steps later on a drawing.
 */
function checkAccessory(a: Accessory): { severity: 'error' | 'warning'; message: string }[] {
  const out: { severity: 'error' | 'warning'; message: string }[] = []
  if (a.runCurrentA <= 0) {
    out.push({ severity: 'error', message: 'Continuous current must be above zero.' })
  }

  const family = fuseFamilyById(fuseFamilyFor(a))
  if (family && a.fuseA && !family.ratings_a.includes(a.fuseA)) {
    out.push({
      severity: 'error',
      message: `${a.fuseA} A is not a standard ${family.label} rating. Nearest are ${nearest(
        family.ratings_a,
        a.fuseA,
      ).join(' and ')} A.`,
    })
  }
  if (a.fuseA && a.fuseA < a.runCurrentA) {
    out.push({
      severity: 'error',
      message: 'Fuse is below the continuous draw — it will blow in service.',
    })
  } else if (a.fuseA && a.fuseA < a.runCurrentA * 1.25) {
    out.push({
      severity: 'warning',
      message: `Below 1.25 x continuous (${(a.runCurrentA * 1.25).toFixed(1)} A). Acceptable if it is a vendor kit figure.`,
    })
  }

  if (a.cableStartMm2) {
    const size = WIRE_SIZES.find((s) => s.area_mm2 >= a.cableStartMm2)
    if (!size) {
      out.push({ severity: 'error', message: 'No catalogued conductor is that large.' })
    } else if (a.fuseA) {
      // Whether a fuse protects a conductor depends on which ampacity basis the
      // loom is built to, so report both rather than asserting one as fact.
      const nz = deratedAmpacity(size, 'as_nzs_3808', 30, 1).value
      const sae = deratedAmpacity(size, 'sae_j1128', 30, 1).value
      if (a.fuseA > nz && a.fuseA > sae) {
        out.push({
          severity: 'error',
          message: `${a.fuseA} A fuse exceeds ${size.label} on both bases (AS/NZS ${nz.toFixed(0)} A, SAE ${sae.toFixed(0)} A) — the wire would fail first. Upsize the starting cable.`,
        })
      } else if (a.fuseA > nz) {
        out.push({
          severity: 'warning',
          message: `${a.fuseA} A fuse is within ${size.label} on the SAE basis (${sae.toFixed(0)} A) but over it on AS/NZS 3808 (${nz.toFixed(0)} A). On an NZ build this run needs a larger conductor.`,
        })
      }
    }
  }

  const seriesId = connectorSeriesFor(a)
  const series = seriesId ? connectorSeriesById(seriesId) : null
  if (series && a.runCurrentA > series.currentRating_a) {
    out.push({
      severity: 'error',
      message: `${amps(a.runCurrentA)} exceeds the ${series.currentRating_a} A per-contact rating of ${series.label}.`,
    })
  }
  return out
}

/** The catalogued ratings either side of a target, for a "did you mean" hint. */
function nearest(ratings: number[], target: number): number[] {
  const below = ratings.filter((r) => r <= target).pop()
  const above = ratings.find((r) => r >= target)
  return [below, above].filter((x): x is number => x !== undefined)
}

function AccessoryEditor() {
  const [list, setList] = useState<Accessory[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = () =>
    getRepository()
      .then((r) => r.listAccessories())
      .then(setList)

  useEffect(() => {
    void load()
  }, [])

  const selected = list?.find((a) => a.id === selectedId) ?? null

  const save = async (next: Accessory) => {
    setList((cur) => cur?.map((a) => (a.id === next.id ? next : a)) ?? cur)
    const repo = await getRepository()
    await repo.upsertAccessory(next)
  }

  const remove = async (id: string) => {
    setList((cur) => cur?.filter((a) => a.id !== id) ?? cur)
    setSelectedId(null)
    const repo = await getRepository()
    await repo.deleteAccessory(id)
  }

  const addNew = async () => {
    const id = `custom-${Date.now().toString(36)}`
    const fresh: Accessory = {
      id,
      name: 'New accessory',
      brand: '',
      exampleModel: '',
      category: 'Other',
      loadClass: 'power',
      runCurrentA: 1,
      inrushA: null,
      fuseA: 5,
      fuseType: 'ATO',
      connector: 'DT',
      ways: 2,
      ground: 'return-in-loom',
      cableStartMm2: 1.13,
      driveVia: 'direct',
      ref: '',
      notes: null,
    }
    setList((cur) => [...(cur ?? []), fresh])
    setSelectedId(id)
    const repo = await getRepository()
    await repo.upsertAccessory(fresh)
  }

  const reset = async () => {
    const repo = await getRepository()
    setList(await repo.resetAccessories())
    setSelectedId(null)
  }

  const filtered = useMemo(() => {
    if (!list) return []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((a) => `${a.name} ${a.brand} ${a.category}`.toLowerCase().includes(q))
  }, [list, query])

  const edited = useMemo(() => {
    if (!list) return new Set<string>()
    const stock = new Map(ACCESSORY_CATALOG.map((a) => [a.id, JSON.stringify(a)]))
    return new Set(
      list.filter((a) => stock.has(a.id) && stock.get(a.id) !== JSON.stringify(a)).map((a) => a.id),
    )
  }, [list])

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 px-4">
        <Link to="/" className="text-sm text-neutral-500 hover:text-neutral-200">
          ←
        </Link>
        <h1 className="flex-1 text-sm font-medium">Accessory catalogue</h1>
        <Button size="sm" onClick={() => void addNew()}>
          Add accessory
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void reset()}>
          Reset to shipped catalogue
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
          <div className="p-2">
            <Input
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
          <ul className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {filtered.map((a) => {
              const problems = checkAccessory(a)
              return (
                <li key={a.id}>
                  <button
                    onClick={() => setSelectedId(a.id)}
                    className={`block w-full rounded px-2 py-1.5 text-left transition-colors ${
                      selectedId === a.id ? 'bg-neutral-800' : 'hover:bg-neutral-900'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{a.name}</span>
                      {problems.some((p) => p.severity === 'error') ? (
                        <Badge tone="error">!</Badge>
                      ) : edited.has(a.id) ? (
                        <Badge tone="info">edited</Badge>
                      ) : null}
                    </div>
                    <div className="font-mono text-[10px] text-neutral-600">
                      {amps(a.runCurrentA)} · {a.fuseA} A {a.fuseType} · {a.connector}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        <main className="min-h-0 flex-1 overflow-auto">
          {!selected ? (
            <EmptyState title="Pick an accessory">
              Every rating here is editable and is what the sizing engine uses.
            </EmptyState>
          ) : (
            <AccessoryForm
              key={selected.id}
              accessory={selected}
              onChange={(next) => void save(next)}
              onDelete={() => void remove(selected.id)}
            />
          )}
        </main>
      </div>
    </div>
  )
}

function AccessoryForm({
  accessory,
  onChange,
  onDelete,
}: {
  accessory: Accessory
  onChange: (a: Accessory) => void
  onDelete: () => void
}) {
  const set = <K extends keyof Accessory>(key: K, value: Accessory[K]) =>
    onChange({ ...accessory, [key]: value })
  const problems = checkAccessory(accessory)

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={accessory.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Category">
          <Input value={accessory.category} onChange={(e) => set('category', e.target.value)} />
        </Field>
        <Field label="Brand">
          <Input value={accessory.brand} onChange={(e) => set('brand', e.target.value)} />
        </Field>
        <Field label="Model">
          <Input value={accessory.exampleModel} onChange={(e) => set('exampleModel', e.target.value)} />
        </Field>
      </div>

      <fieldset className="grid grid-cols-3 gap-3 rounded-md border border-neutral-800 p-3">
        <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">
          Electrical
        </legend>
        <Field label="Continuous (A)">
          <NumberInput
            step="0.1"
            value={accessory.runCurrentA}
            onValueChange={(v) => set('runCurrentA', v ?? 0)}
          />
        </Field>
        <Field label="Inrush (A)">
          <NumberInput
            step="1"
            value={accessory.inrushA ?? undefined}
            onValueChange={(v) => set('inrushA', v ?? null)}
          />
        </Field>
        <Field label="Load class">
          <Select
            value={accessory.loadClass}
            onChange={(e) => set('loadClass', e.target.value as AccessoryLoadClass)}
          >
            {LOAD_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fuse (A)">
          <NumberInput
            step="0.5"
            value={accessory.fuseA}
            onValueChange={(v) => set('fuseA', v ?? 0)}
          />
        </Field>
        <Field label="Fuse type">
          <Select
            value={accessory.fuseType}
            onChange={(e) => set('fuseType', e.target.value as AccessoryFuseType)}
          >
            {FUSE_TYPES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Starting cable (mm²)" hint="The engine finalises this per run length.">
          <NumberInput
            step="0.1"
            value={accessory.cableStartMm2}
            onValueChange={(v) => set('cableStartMm2', v ?? 0)}
          />
        </Field>
      </fieldset>

      <fieldset className="grid grid-cols-3 gap-3 rounded-md border border-neutral-800 p-3">
        <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">
          Termination
        </legend>
        <Field label="Connector">
          <Select
            value={accessory.connector}
            onChange={(e) => set('connector', e.target.value as AccessoryConnector)}
          >
            {CONNECTORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ways">
          <NumberInput value={accessory.ways} onValueChange={(v) => set('ways', v ?? 2)} />
        </Field>
        <Field label="Ground">
          <Select
            value={accessory.ground}
            onChange={(e) => set('ground', e.target.value as Accessory['ground'])}
          >
            <option value="local">local</option>
            <option value="return-in-loom">return-in-loom</option>
            <option value="stud">stud</option>
          </Select>
        </Field>
      </fieldset>

      <Field label="Datasheet reference">
        <Input value={accessory.ref} onChange={(e) => set('ref', e.target.value)} />
      </Field>
      <Field label="Notes">
        <Textarea
          value={accessory.notes ?? ''}
          onChange={(e) => set('notes', e.target.value || null)}
        />
      </Field>

      {problems.length ? (
        <ul className="space-y-1">
          {problems.map((p, i) => (
            <li
              key={i}
              className={`rounded border p-2 text-xs leading-relaxed ${
                p.severity === 'error'
                  ? 'border-red-900/70 bg-red-950/30 text-red-100'
                  : 'border-amber-900/60 bg-amber-950/25 text-amber-100'
              }`}
            >
              {p.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-emerald-500">Ratings are self-consistent.</p>
      )}

      <Button variant="danger" size="sm" onClick={onDelete}>
        Delete accessory
      </Button>
    </div>
  )
}
