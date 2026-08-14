import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { FormboardView } from '~/components/formboard-view'
import { Inspector } from '~/components/inspector'
import { LoadPalette } from '~/components/load-palette'
import { SchematicCanvas, type Selection } from '~/components/schematic-canvas'
import { SummaryPanel } from '~/components/summary-panel'
import { Badge, Button, Panel, Select } from '~/components/ui'
import { nextCircuitId, nextId, useLoom } from '~/hooks/use-loom'
import { downloadBom, downloadCutList, downloadDrawing } from '~/lib/export/download'
import type { AmpacityBasis, LoomEdge, LoomNode, NodeKind, WireFamily } from '~/lib/loom/types'

export const Route = createFileRoute('/looms/$loomId')({ component: Editor })

function Editor() {
  const { loomId } = Route.useParams()
  const ctx = useLoom(loomId)
  const [selection, setSelection] = useState<Selection>(null)
  const [view, setView] = useState<'schematic' | 'formboard'>('schematic')

  if (ctx.loading) return <Shell><p className="p-8 text-sm text-neutral-600">Loading…</p></Shell>
  if (ctx.loadError || !ctx.loom || !ctx.analysis) {
    return (
      <Shell>
        <p className="p-8 text-sm text-red-400">{ctx.loadError ?? 'Could not load this loom.'}</p>
      </Shell>
    )
  }

  const { loom, analysis } = ctx

  const addNode = (kind: NodeKind) => {
    const node: LoomNode = {
      id: nextId(kind, loom.nodes),
      kind,
      name:
        kind === 'load'
          ? 'New load'
          : kind === 'ground'
            ? 'Ground stud'
            : kind === 'connector'
              ? 'Connector'
              : kind === 'splice'
                ? 'Splice'
                : 'Power source',
      location: '',
      position: { x: 260 + loom.nodes.length * 12, y: 140 + (loom.nodes.length % 7) * 66 },
      ...(kind === 'load' ? { load: { continuousCurrent_a: 1, duty: 'continuous' as const } } : {}),
      ...(kind === 'source'
        ? { source: { nominalVoltage_v: loom.settings.systemVoltage_v, capacity_a: 120 } }
        : {}),
      ...(kind === 'ground' ? { ground: { method: 'chassis' as const, stud: 'M8' } } : {}),
      ...(kind === 'connector' ? { connector: { seriesId: 'deutsch-dt', ways: 2 } } : {}),
      ...(kind === 'splice' ? { splice: { method: 'crimp' as const } } : {}),
    }
    ctx.addNode(node)
    setSelection({ kind: 'node', id: node.id })
  }

  const connect = (fromId: string, toId: string) => {
    const to = loom.nodes.find((n) => n.id === toId)
    const isGround = to?.kind === 'ground' || to?.kind === 'splice'
    const from = loom.nodes.find((n) => n.id === fromId)
    // A run into a ground node is a return; anything leaving a source is fused.
    const groundRun = to?.kind === 'ground'
    const edge: LoomEdge = {
      id: nextId('run', loom.edges),
      fromNodeId: fromId,
      toNodeId: toId,
      circuitId: nextCircuitId(loom.edges),
      length_mm: 1000,
      class: groundRun ? 'ground' : 'power',
      returnPath: 'modeled',
      ...(groundRun || !from || isGround === undefined
        ? {}
        : from.kind === 'source' || from.kind === 'splice'
          ? { protection: { familyId: 'ato' } }
          : {}),
    }
    ctx.addEdge(edge)
    setSelection({ kind: 'edge', id: edge.id })
  }

  return (
    <Shell>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 px-3">
        <Link to="/" className="text-sm text-neutral-500 hover:text-neutral-200">
          ←
        </Link>
        <input
          value={loom.name}
          onChange={(e) => ctx.patchLoom({ name: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-neutral-100 outline-none"
        />
        <Badge tone={analysis.errorCount ? 'error' : analysis.warningCount ? 'warning' : 'ok'}>
          {analysis.errorCount
            ? `${analysis.errorCount} error${analysis.errorCount === 1 ? '' : 's'}`
            : analysis.warningCount
              ? `${analysis.warningCount} warning${analysis.warningCount === 1 ? '' : 's'}`
              : 'passes'}
        </Badge>
        <span className="w-14 text-right text-[11px] text-neutral-600">
          {ctx.saveState === 'saving' ? 'saving…' : ctx.saveState === 'error' ? 'save failed' : ctx.saveState === 'saved' ? 'saved' : ''}
        </span>
        <Button size="sm" variant="ghost" onClick={ctx.undo} disabled={!ctx.canUndo}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" onClick={ctx.redo} disabled={!ctx.canRedo}>
          Redo
        </Button>

        <div className="ml-1 flex overflow-hidden rounded-md border border-neutral-700">
          {(['schematic', 'formboard'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={
                'h-7 px-3 text-xs font-medium transition-colors ' +
                (view === v
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200')
              }
            >
              {v === 'schematic' ? 'Schematic' : 'Formboard'}
            </button>
          ))}
        </div>

        <Button size="sm" onClick={() => downloadDrawing(analysis)}>
          Drawing PDF
        </Button>
        <Button size="sm" variant="ghost" onClick={() => downloadCutList(analysis)}>
          Cut list
        </Button>
        <Button size="sm" variant="ghost" onClick={() => downloadBom(analysis)}>
          BOM
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-800">
          <Panel title="Add" className="!h-auto shrink-0">
            <div className="grid grid-cols-2 gap-1.5 p-2">
              {(['load', 'splice', 'connector', 'ground', 'source'] as NodeKind[]).map((k) => (
                <Button key={k} size="sm" onClick={() => addNode(k)}>
                  {k}
                </Button>
              ))}
            </div>
          </Panel>
          <div className="min-h-0 flex-1 border-t border-neutral-800">
            <Panel title="Accessory palette">
              <LoadPalette
                onAdd={(node) => {
                  ctx.addNode({
                    ...node,
                    id: nextId('load', loom.nodes),
                    position: { x: 300 + loom.nodes.length * 10, y: 160 + (loom.nodes.length % 7) * 66 },
                  })
                }}
              />
            </Panel>
          </div>
          <div className="shrink-0 border-t border-neutral-800">
            <Panel title="Loom settings" className="!h-auto">
              <div className="space-y-2 p-2">
                <Select
                  value={loom.settings.ampacityBasis}
                  onChange={(e) =>
                    ctx.patchSettings({ ampacityBasis: e.target.value as AmpacityBasis })
                  }
                >
                  <option value="as_nzs_3808">AS/NZS 3808 (NZ build)</option>
                  <option value="sae_j1128">SAE J1128 (chassis wiring)</option>
                </Select>
                <Select
                  value={loom.settings.defaultFamily}
                  onChange={(e) => ctx.patchSettings({ defaultFamily: e.target.value as WireFamily })}
                >
                  <option value="awg">AWG / B&amp;S</option>
                  <option value="metric">Metric mm²</option>
                </Select>
              </div>
            </Panel>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {view === 'schematic' ? (
            <SchematicCanvas
              loom={loom}
              analysis={analysis}
              selection={selection}
              onSelect={setSelection}
              onMoveNode={(id, position) => ctx.patchNode(id, { position })}
              onConnect={connect}
            />
          ) : (
            <FormboardView
              analysis={analysis}
              selection={selection}
              onSelect={setSelection}
              onMoveNode={(id, formboardPosition) => ctx.patchNode(id, { formboardPosition })}
            />
          )}
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-800">
          <div className="min-h-0 flex-1">
            <Panel title="Inspector">
              <Inspector
                loom={loom}
                analysis={analysis}
                selection={selection}
                onPatchNode={ctx.patchNode}
                onPatchEdge={ctx.patchEdge}
                onRemoveNode={(id) => {
                  ctx.removeNode(id)
                  setSelection(null)
                }}
                onRemoveEdge={(id) => {
                  ctx.removeEdge(id)
                  setSelection(null)
                }}
              />
            </Panel>
          </div>
          <div className="min-h-0 flex-1 border-t border-neutral-800">
            <SummaryPanel
              analysis={analysis}
              onSelectEdge={(id) => setSelection({ kind: 'edge', id })}
              onSelectNode={(id) => setSelection({ kind: 'node', id })}
            />
          </div>
        </aside>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen flex-col overflow-hidden">{children}</div>
}
