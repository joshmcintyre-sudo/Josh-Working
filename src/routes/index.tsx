import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getRepository, isSupabaseConfigured, type LoomSummary } from '~/lib/db'
import { DEFAULT_SETTINGS, type Loom } from '~/lib/loom/types'
import { Badge, Button, EmptyState, Input } from '~/components/ui'

export const Route = createFileRoute('/')({ component: LoomList })

function LoomList() {
  const router = useRouter()
  const [looms, setLooms] = useState<LoomSummary[] | null>(null)
  const [name, setName] = useState('')
  const [storage, setStorage] = useState<'supabase' | 'local'>('local')

  const refresh = () =>
    getRepository().then(async (repo) => {
      setStorage(repo.kind)
      setLooms(await repo.listLooms())
    })

  useEffect(() => {
    void refresh()
  }, [])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const repo = await getRepository()
    const id = `${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`
    const loom: Loom = {
      id,
      name: trimmed,
      revision: 'A',
      settings: { ...DEFAULT_SETTINGS },
      formboard: { width_mm: 2400, height_mm: 1200 },
      nodes: [
        {
          id: 'bat',
          kind: 'source',
          name: 'Main battery +',
          location: '',
          position: { x: 80, y: 260 },
          source: { nominalVoltage_v: 12, capacity_a: 120 },
        },
        {
          id: 'gnd',
          kind: 'ground',
          name: 'Chassis ground stud',
          location: '',
          position: { x: 80, y: 420 },
          ground: { method: 'chassis', stud: 'M8' },
        },
      ],
      edges: [],
    }
    await repo.createLoom(loom)
    void router.navigate({ to: '/looms/$loomId', params: { loomId: id } })
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Loom Designer</h1>
          <p className="mt-1 text-sm text-neutral-500">
            12 V DC wiring looms — sized, validated and drawn for the board.
          </p>
        </div>
        <Link to="/accessories" className="text-sm text-sky-400 hover:text-sky-300">
          Accessory catalogue →
        </Link>
      </header>

      {!isSupabaseConfigured() ? (
        <p className="mb-6 rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-xs leading-relaxed text-neutral-400">
          <Badge tone="info">local storage</Badge>{' '}
          Supabase is not configured, so designs are saved in this browser only. Set{' '}
          <code className="text-neutral-300">VITE_SUPABASE_URL</code> and{' '}
          <code className="text-neutral-300">VITE_SUPABASE_ANON_KEY</code> and run the migration in{' '}
          <code className="text-neutral-300">supabase/migrations</code> to sync across machines.
        </p>
      ) : null}

      <div className="mb-6 flex gap-2">
        <Input
          placeholder="New loom name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
          Create
        </Button>
      </div>

      {looms === null ? (
        <p className="text-sm text-neutral-600">Loading…</p>
      ) : looms.length === 0 ? (
        <EmptyState title="No looms yet.">Name one above to get started.</EmptyState>
      ) : (
        <ul className="divide-y divide-neutral-900 rounded-md border border-neutral-800">
          {looms.map((l) => (
            <li key={l.id}>
              <Link
                to="/looms/$loomId"
                params={{ loomId: l.id }}
                className="flex items-center justify-between gap-4 p-3 transition-colors hover:bg-neutral-900"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-neutral-100">{l.name}</div>
                  {l.description ? (
                    <div className="truncate text-xs text-neutral-500">{l.description}</div>
                  ) : null}
                </div>
                <div className="shrink-0 font-mono text-[11px] text-neutral-600 tabular-nums">
                  rev {l.revision} · {l.nodeCount} nodes · {l.edgeCount} runs
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-[11px] text-neutral-700">Storage: {storage}</p>
    </div>
  )
}
