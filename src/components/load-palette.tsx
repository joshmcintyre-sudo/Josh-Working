/**
 * Accessory palette.
 *
 * Reads the account's editable catalogue, so a load dropped on the canvas
 * carries whatever current and inrush the shop has recorded for that part —
 * not a figure baked into the code.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { getRepository } from '~/lib/db'
import {
  connectorSeriesFor,
  fuseFamilyFor,
  type Accessory,
} from '~/lib/loom/accessories'
import type { LoomNode } from '~/lib/loom/types'
import { amps } from '~/lib/utils'
import { Input } from './ui'

export function LoadPalette({ onAdd }: { onAdd: (node: Omit<LoomNode, 'id'> & { id: string }) => void }) {
  const [catalog, setCatalog] = useState<Accessory[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    void getRepository()
      .then((r) => r.listAccessories())
      .then(setCatalog)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter((a) =>
      `${a.name} ${a.brand} ${a.category} ${a.exampleModel}`.toLowerCase().includes(q),
    )
  }, [catalog, query])

  const byCategory = useMemo(() => {
    const map = new Map<string, Accessory[]>()
    for (const a of filtered) map.set(a.category, [...(map.get(a.category) ?? []), a])
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <Input
          placeholder="Search accessories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {byCategory.map(([category, items]) => (
          <div key={category} className="mb-2">
            <div className="px-1 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
              {category}
            </div>
            {items.map((a) => (
              <button
                key={a.id}
                onClick={() => onAdd(toNode(a))}
                className="block w-full rounded px-1.5 py-1 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
              >
                <span className="block truncate">{a.name}</span>
                <span className="block font-mono text-[10px] text-neutral-600">
                  {amps(a.runCurrentA)}
                  {a.inrushA ? ` · ${amps(a.inrushA)} inrush` : ''} · {a.fuseA} A {a.fuseType}
                </span>
              </button>
            ))}
          </div>
        ))}
        {catalog.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-neutral-600">Loading catalogue…</p>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-neutral-800 p-2">
        <Link to="/accessories" className="text-[11px] text-sky-500 hover:text-sky-400">
          Edit catalogue and ratings →
        </Link>
      </div>
    </div>
  )
}

function toNode(a: Accessory): LoomNode {
  const series = connectorSeriesFor(a)
  return {
    id: a.id,
    kind: 'load',
    name: a.name,
    location: '',
    position: { x: 0, y: 0 },
    load: {
      continuousCurrent_a: a.runCurrentA,
      inrushCurrent_a: a.inrushA ?? undefined,
      duty: a.loadClass === 'signal' ? 'momentary' : 'continuous',
      description: `${a.brand} ${a.exampleModel}`.trim(),
    },
    connector: series ? { seriesId: series, ways: a.ways } : undefined,
    protection: { familyId: fuseFamilyFor(a), rating_a: a.fuseA },
    notes: [a.notes, a.ref].filter(Boolean).join(' — ') || undefined,
  }
}
