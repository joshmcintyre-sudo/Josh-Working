/**
 * Live parts and current summary.
 *
 * Recomputed from the analysis on every edit, so the numbers on screen are
 * always the numbers that would be exported. Three views: totals, the parts
 * roll-up, and the validation list.
 */

import { useState } from 'react'
import type { Issue, LoomAnalysis } from '~/lib/loom/analysis'
import { buildBom } from '~/lib/loom/bom'
import { amps, cn, grams, mm } from '~/lib/utils'
import { Badge, EmptyState, Stat } from './ui'

type Tab = 'summary' | 'parts' | 'checks'

export function SummaryPanel({
  analysis,
  onSelectEdge,
  onSelectNode,
}: {
  analysis: LoomAnalysis
  onSelectEdge: (id: string) => void
  onSelectNode: (id: string) => void
}) {
  const [tab, setTab] = useState<Tab>('summary')
  const errors = analysis.issues.filter((i) => i.severity === 'error')
  const warnings = analysis.issues.filter((i) => i.severity === 'warning')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 border-b border-neutral-800 text-xs">
        {(
          [
            ['summary', 'Summary'],
            ['parts', 'Parts'],
            ['checks', `Checks${errors.length ? ` (${errors.length})` : ''}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'h-9 flex-1 border-b-2 px-2 font-medium transition-colors',
              tab === id
                ? 'border-sky-500 text-neutral-100'
                : 'border-transparent text-neutral-500 hover:text-neutral-300',
              id === 'checks' && errors.length ? 'text-red-400' : '',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'summary' ? <SummaryTab analysis={analysis} /> : null}
        {tab === 'parts' ? <PartsTab analysis={analysis} /> : null}
        {tab === 'checks' ? (
          <ChecksTab
            errors={errors}
            warnings={warnings}
            infos={analysis.issues.filter((i) => i.severity === 'info')}
            onSelectEdge={onSelectEdge}
            onSelectNode={onSelectNode}
          />
        ) : null}
      </div>
    </div>
  )
}

function SummaryTab({ analysis }: { analysis: LoomAnalysis }) {
  const t = analysis.totals
  const over = t.utilisationPct > 100
  const near = t.utilisationPct > 80
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Continuous load" value={amps(t.continuousLoad_a)} sub={`${t.circuitCount} circuits`} />
        <Stat
          label="Source capacity"
          value={amps(t.sourceCapacity_a)}
          sub={
            <span className={over ? 'text-red-400' : near ? 'text-amber-400' : undefined}>
              {t.utilisationPct.toFixed(0)} % used
            </span>
          }
        />
        <Stat label="Worst-case inrush" value={amps(t.peakInrush_a)} sub="all loads at once" />
        <Stat label="Wire" value={mm(t.wireLength_mm)} sub={grams(t.mass_g)} />
      </div>

      <div>
        <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">Wire by size</h3>
        <table className="w-full text-xs">
          <tbody>
            {t.wireLengthBySize.map((row) => (
              <tr key={row.size.id} className="border-b border-neutral-900">
                <td className="py-1 font-mono text-neutral-200">{row.size.label}</td>
                <td className="py-1 text-right font-mono text-neutral-400 tabular-nums">
                  {mm(row.length_mm)}
                </td>
                <td className="py-1 text-right font-mono text-neutral-600 tabular-nums">
                  {grams(row.mass_g)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">
          What is driving each size
        </h3>
        <div className="space-y-1">
          {Object.entries(
            analysis.edges.reduce<Record<string, number>>((acc, e) => {
              acc[e.sizing.limitingConstraint] = (acc[e.sizing.limitingConstraint] ?? 0) + 1
              return acc
            }, {}),
          )
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-neutral-400">{k.replace(/_/g, ' ')}</span>
                <span className="font-mono text-neutral-500 tabular-nums">{n}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function PartsTab({ analysis }: { analysis: LoomAnalysis }) {
  const bom = buildBom(analysis)
  return (
    <div className="space-y-4">
      {bom.groups.map((group) => (
        <div key={group.title}>
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">
            {group.title}
          </h3>
          <table className="w-full text-xs">
            <tbody>
              {group.lines.map((line) => (
                <tr key={line.key} className="border-b border-neutral-900 align-top">
                  <td className="py-1 pr-2 text-neutral-200">
                    {line.description}
                    {line.partNumber ? (
                      <span className="ml-1 font-mono text-[10px] text-neutral-500">
                        {line.partNumber}
                      </span>
                    ) : null}
                    {line.note ? (
                      <div className="text-[10px] leading-snug text-neutral-600">{line.note}</div>
                    ) : null}
                  </td>
                  <td className="w-16 py-1 text-right font-mono text-neutral-400 tabular-nums">
                    {line.quantity}
                    {line.unit ? ` ${line.unit}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {bom.unresolvedPartNumbers > 0 ? (
        <p className="rounded border border-amber-900/60 bg-amber-950/40 p-2 text-[11px] leading-relaxed text-amber-200">
          {bom.unresolvedPartNumbers} line
          {bom.unresolvedPartNumbers === 1 ? '' : 's'} need a part number confirmed against the
          supplier catalogue before this goes out for manufacture.
        </p>
      ) : null}
    </div>
  )
}

function ChecksTab({
  errors,
  warnings,
  infos,
  onSelectEdge,
  onSelectNode,
}: {
  errors: Issue[]
  warnings: Issue[]
  infos: Issue[]
  onSelectEdge: (id: string) => void
  onSelectNode: (id: string) => void
}) {
  if (!errors.length && !warnings.length && !infos.length) {
    return <EmptyState title="Everything checks out.">No errors, warnings or notes.</EmptyState>
  }
  const go = (i: Issue) => {
    if (i.edgeId) onSelectEdge(i.edgeId)
    else if (i.nodeId) onSelectNode(i.nodeId)
  }
  return (
    <div className="space-y-3">
      {(
        [
          ['error', errors],
          ['warning', warnings],
          ['info', infos],
        ] as const
      ).map(([severity, list]) =>
        list.length ? (
          <div key={severity} className="space-y-1">
            {list.map((i, k) => (
              <button
                key={`${severity}-${k}`}
                onClick={() => go(i)}
                className={cn(
                  'block w-full rounded border p-2 text-left text-xs leading-relaxed transition-colors',
                  severity === 'error'
                    ? 'border-red-900/70 bg-red-950/30 text-red-100 hover:bg-red-950/60'
                    : severity === 'warning'
                      ? 'border-amber-900/60 bg-amber-950/25 text-amber-100 hover:bg-amber-950/50'
                      : 'border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:bg-neutral-900',
                )}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <Badge tone={severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info'}>
                    {i.code.replace(/_/g, ' ')}
                  </Badge>
                </div>
                {i.message}
                {i.remedy ? (
                  <div className="mt-1 text-[11px] opacity-70">→ {i.remedy}</div>
                ) : null}
              </button>
            ))}
          </div>
        ) : null,
      )}
    </div>
  )
}
