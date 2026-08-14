/**
 * Release a revision.
 *
 * Freezing writes the calculated schedule to storage exactly as it stands, so a
 * drawing already on the floor cannot change underneath the builder when
 * someone revises the loom or the reference data. The dialog refuses to release
 * a loom with errors, because a frozen error is worse than a live one — it
 * looks authoritative.
 */

import { useEffect, useState } from 'react'
import { currentDataRevisions, getRepository, wireRowsFromAnalysis } from '~/lib/db'
import type { LoomAnalysis } from '~/lib/loom/analysis'
import { Badge, Button, Field, Input } from './ui'

export interface ReleaseSummary {
  revision: string
  releasedAt: string
  count: number
}

export function ReleaseDialog({
  analysis,
  onClose,
  onReleased,
}: {
  analysis: LoomAnalysis
  onClose: () => void
  onReleased: (revision: string) => void
}) {
  const loom = analysis.loom
  const [revision, setRevision] = useState(loom.revision)
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getRepository()
      .then((repo) => repo.listReleases(loom.id))
      .then(setReleases)
      .catch(() => setReleases([]))
  }, [loom.id])

  const revisions = currentDataRevisions()
  const existing = releases?.find((r) => r.revision === revision)
  const rows = wireRowsFromAnalysis(loom.id, revision, analysis)

  const release = async () => {
    setBusy(true)
    setError(null)
    try {
      const repo = await getRepository()
      await repo.releaseWires(loom.id, revision, rows)
      onReleased(revision)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
        <h2 className="text-sm font-medium text-neutral-100">Release a revision</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
          Freezes the wire schedule as it stands now. A released revision does not change when the
          loom or the reference data is revised afterwards.
        </p>

        {analysis.errorCount > 0 ? (
          <p className="mt-3 rounded border border-red-900/70 bg-red-950/40 p-2 text-xs leading-relaxed text-red-200">
            {analysis.errorCount} error{analysis.errorCount === 1 ? '' : 's'} outstanding. Clear them
            before releasing — a frozen error looks authoritative on the floor.
          </p>
        ) : null}

        <div className="mt-3 space-y-3">
          <Field label="Revision" hint="Usually a letter. Reusing one overwrites that release.">
            <Input value={revision} onChange={(e) => setRevision(e.target.value.toUpperCase())} />
          </Field>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-neutral-800 bg-neutral-900/60 p-2.5 text-[11px]">
            <dt className="text-neutral-500">Wires frozen</dt>
            <dd className="text-right font-mono text-neutral-300">{rows.length}</dd>
            <dt className="text-neutral-500">Reference data</dt>
            <dd className="text-right font-mono text-neutral-300">
              wire {revisions.wire}
            </dd>
            <dt className="text-neutral-500">Warnings carried</dt>
            <dd className="text-right font-mono text-neutral-300">{analysis.warningCount}</dd>
          </dl>

          {existing ? (
            <p className="rounded border border-amber-900/60 bg-amber-950/30 p-2 text-[11px] text-amber-200">
              Revision {revision} was already released with {existing.count} wires. Releasing again
              replaces it.
            </p>
          ) : null}

          {releases?.length ? (
            <div>
              <h3 className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                Released so far
              </h3>
              <ul className="space-y-0.5">
                {releases.map((r) => (
                  <li key={r.revision} className="flex justify-between text-[11px] text-neutral-400">
                    <span>
                      <Badge tone="ok">{r.revision}</Badge> {r.count} wires
                    </span>
                    <span className="font-mono text-neutral-600">
                      {r.releasedAt ? r.releasedAt.slice(0, 10) : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || analysis.errorCount > 0 || !revision.trim()}
            onClick={() => void release()}
          >
            {busy ? 'Freezing…' : `Freeze revision ${revision}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
