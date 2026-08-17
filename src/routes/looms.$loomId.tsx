import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ConfirmDialog, ContextMenu, DistancePrompt, type MenuItem } from '~/components/context-menu'
import { ReleaseDialog } from '~/components/release-dialog'
import { FormboardView } from '~/components/formboard-view'
import { Inspector } from '~/components/inspector'
import { LoadPalette } from '~/components/load-palette'
import { SchematicCanvas, type Selection } from '~/components/schematic-canvas'
import { SummaryPanel } from '~/components/summary-panel'
import { Badge, Button, Panel, Select } from '~/components/ui'
import { nextCircuitId, nextId, useLoom } from '~/hooks/use-loom'
import { downloadBom, downloadCutList, downloadDrawing, downloadPinouts } from '~/lib/export/download'
import { inferWireClass, nodeDeletionImpact, segmentDeletionImpact } from '~/lib/loom/mutations'
import type { AmpacityBasis, Loom, LoomEdge, LoomNode, NodeKind, WireFamily } from '~/lib/loom/types'
import type { LoomAnalysis } from '~/lib/loom/analysis'

export const Route = createFileRoute('/looms/$loomId')({ component: Editor })

function Editor() {
  const { loomId } = Route.useParams()
  const ctx = useLoom(loomId)
  const [selection, setSelection] = useState<Selection>(null)
  const [view, setView] = useState<'schematic' | 'formboard'>('schematic')
  const [menu, setMenu] = useState<{ selection: Selection; at: { x: number; y: number } } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: React.ReactNode; run: () => void } | null>(null)
  const [splice, setSplice] = useState<{ edgeId: string; max: number } | null>(null)
  const [bundleFrom, setBundleFrom] = useState<string | null>(null)
  const [branchFrom, setBranchFrom] = useState<string | null>(null)
  const [branchTarget, setBranchTarget] = useState<{ segmentId: string; max: number } | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [released, setReleased] = useState<string | null>(null)

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
                : kind === 'termination'
                  ? 'Flush cut'
                  : 'Power source',
      location: '',
      position: { x: 260 + loom.nodes.length * 12, y: 140 + (loom.nodes.length % 7) * 66 },
      ...(kind === 'load' || kind === 'termination'
        ? { load: { continuousCurrent_a: 1, duty: 'continuous' as const } }
        : {}),
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
    // Attaching a duplicated branch to an existing node instead of drawing a wire.
    if (branchFrom) {
      ctx.duplicateBranch(branchFrom, { nodeId: toId })
      setBranchFrom(null)
      return
    }
    // Drawing a bundle instead of a wire.
    if (bundleFrom) {
      ctx.connectBundle(bundleFrom, toId, 500)
      setBundleFrom(null)
      return
    }
    const from = loom.nodes.find((n) => n.id === fromId)
    const wireClass = inferWireClass(loom, fromId, toId)
    const edge: LoomEdge = {
      id: nextId('run', loom.edges),
      fromNodeId: fromId,
      toNodeId: toId,
      circuitId: nextCircuitId(loom.edges),
      length_mm: 1000,
      class: wireClass,
      returnPath: 'modeled',
      // A run leaving the battery or a distribution point is fused; a return
      // never is.
      ...(wireClass !== 'ground' && (from?.kind === 'source' || from?.kind === 'splice')
        ? { protection: { familyId: 'ato' } }
        : {}),
    }
    ctx.addEdge(edge)
    setSelection({ kind: 'edge', id: edge.id })
  }

  const askDelete = (selection: Selection) => {
    if (!selection) return
    if (selection.kind === 'node') {
      const node = loom.nodes.find((n) => n.id === selection.id)
      const impact = nodeDeletionImpact(loom, selection.id)
      setConfirm({
        title: `Delete "${node?.name ?? selection.id}"?`,
        body: (
          <>
            This also removes {impact.edgeIds.length} run
            {impact.edgeIds.length === 1 ? '' : 's'} and {impact.segmentIds.length} bundle
            {impact.segmentIds.length === 1 ? '' : 's'} attached to it.
            {impact.reroutedEdgeIds.length
              ? ` ${impact.reroutedEdgeIds.length} more run(s) will need re-routing.`
              : ''}
          </>
        ),
        run: () => {
          ctx.removeNode(selection.id)
          setSelection(null)
        },
      })
      return
    }
    if (selection.kind === 'segment') {
      const impact = segmentDeletionImpact(loom, selection.id)
      const load = analysis.segments.find((x) => x.segment.id === selection.id)
      setConfirm({
        title: `Delete bundle "${load?.segment.label ?? selection.id}"?`,
        body: (
          <>
            {load?.edgeIds.length ?? 0} run(s) travel inside it. They stay, but will be re-routed or
            drawn loose.
            {impact.reroutedEdgeIds.length
              ? ` ${impact.reroutedEdgeIds.length} name it explicitly and will fall back to automatic routing.`
              : ''}
          </>
        ),
        run: () => {
          ctx.removeSegment(selection.id)
          setSelection(null)
        },
      })
      return
    }
    const ea = analysis.byEdgeId[selection.id]
    setConfirm({
      title: `Delete run ${ea?.edge.circuitId ?? selection.id}?`,
      body: <>The wire is removed from the schedule, the cut list and the BOM.</>,
      run: () => {
        ctx.removeEdge(selection.id)
        setSelection(null)
      },
    })
  }

  const menuItems = (selection: Selection): MenuItem[] => {
    if (!selection) return []
    if (selection.kind === 'node') {
      const node = loom.nodes.find((n) => n.id === selection.id)
      return [
        { label: 'Duplicate', hint: 'with its ratings', onSelect: () => ctx.duplicate(selection.id) },
        {
          label: branchFrom === selection.id ? 'Cancel duplicate branch' : 'Duplicate branch, off…',
          hint: 'device + connector, reattached elsewhere',
          onSelect: () => setBranchFrom(branchFrom === selection.id ? null : selection.id),
        },
        {
          label: bundleFrom === selection.id ? 'Cancel bundle' : 'Start bundle from here',
          onSelect: () => setBundleFrom(bundleFrom === selection.id ? null : selection.id),
        },
        {
          label: 'Make this a ground point',
          disabled: node?.kind === 'ground',
          onSelect: () =>
            ctx.patchNode(selection.id, { kind: 'ground', ground: { method: 'chassis', stud: 'M8' } }),
        },
        { label: 'Delete', danger: true, onSelect: () => askDelete(selection) },
      ]
    }
    if (selection.kind === 'segment') {
      const load = analysis.segments.find((x) => x.segment.id === selection.id)
      return [
        ...(branchFrom
          ? [
              {
                label: 'Attach duplicate here…',
                hint: 'adds a breakout',
                onSelect: () =>
                  load && setBranchTarget({ segmentId: selection.id, max: load.segment.length_mm }),
              },
            ]
          : []),
        {
          label: 'Straighten bundle',
          disabled: !analysis.segments.find((x) => x.segment.id === selection.id)?.segment.routing
            ?.length,
          onSelect: () => ctx.patchSegment(selection.id, { routing: undefined }),
        },
        {
          label: 'Split bundle here…',
          hint: 'adds a breakout',
          onSelect: () =>
            load &&
            setSplice({ edgeId: `segment:${selection.id}`, max: load.segment.length_mm }),
        },
        {
          label: load?.recommendedSleeving ? `Fit ${load.recommendedSleeving.label.replace(/ ID.*/, '')}` : 'No sleeving suits',
          disabled: !load?.recommendedSleeving,
          onSelect: () =>
            load?.recommendedSleeving &&
            ctx.patchSegment(selection.id, { sleevingId: load.recommendedSleeving.id }),
        },
        { label: 'Delete bundle', danger: true, onSelect: () => askDelete(selection) },
      ]
    }
    const ea = analysis.byEdgeId[selection.id]
    return [
      {
        label: 'Insert splice…',
        hint: 'mid-run',
        onSelect: () => ea && setSplice({ edgeId: selection.id, max: ea.edge.length_mm }),
      },
      { label: 'Duplicate run', onSelect: () => ctx.duplicateRun(selection.id) },
      {
        label: ea?.edge.lengthFromRouting ? 'Use authored length' : 'Take length from bundle',
        disabled: !ea || ea.routing?.unrouted,
        onSelect: () =>
          ctx.patchEdge(selection.id, { lengthFromRouting: !ea?.edge.lengthFromRouting }),
      },
      { label: 'Delete run', danger: true, onSelect: () => askDelete(selection) },
    ]
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
        <Button size="sm" variant="ghost" onClick={() => downloadPinouts(analysis)}>
          Pin-outs
        </Button>
        <Button size="sm" variant="ghost" onClick={() => downloadBom(analysis)}>
          BOM
        </Button>
        <Button size="sm" variant="primary" onClick={() => setReleasing(true)}>
          Release…
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-800">
          <Panel title="Add" className="!h-auto shrink-0">
            <div className="grid grid-cols-2 gap-1.5 p-2">
              {(['load', 'splice', 'connector', 'ground', 'source', 'termination'] as NodeKind[]).map((k) => (
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
              onContextMenu={(sel, at) => setMenu({ selection: sel, at })}
              linkFromNodeId={branchFrom ?? bundleFrom}
              onLinkCancel={() => {
                setBranchFrom(null)
                setBundleFrom(null)
              }}
            />
          ) : (
            <FormboardView
              analysis={analysis}
              selection={selection}
              onSelect={setSelection}
              onMoveNode={(id, formboardPosition) => ctx.patchNode(id, { formboardPosition })}
              onRouteSegment={(id, routing) => ctx.patchSegment(id, { routing })}
              onContextMenu={(sel, at) => setMenu({ selection: sel, at })}
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
                onPatchSegment={ctx.patchSegment}
                onRemoveNode={(id) => askDelete({ kind: 'node', id })}
                onRemoveEdge={(id) => askDelete({ kind: 'edge', id })}
                onRemoveSegment={(id) => askDelete({ kind: 'segment', id })}
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

      {branchFrom ? (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-40 flex justify-center">
          <div className="rounded-md border border-sky-800 bg-sky-950/90 px-3 py-1.5 text-xs text-sky-200">
            Duplicating "{loom.nodes.find((n) => n.id === branchFrom)?.name}" — click a node to attach
            it there, or right-click a bundle for a breakout at a chosen distance. Esc to cancel.
          </div>
        </div>
      ) : null}

      {bundleFrom ? (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-40 flex justify-center">
          <div className="rounded-md border border-sky-800 bg-sky-950/90 px-3 py-1.5 text-xs text-sky-200">
            Drawing a bundle — click the node it runs to. Esc to cancel.
          </div>
        </div>
      ) : null}

      {releasing ? (
        <ReleaseDialog
          analysis={analysis}
          onClose={() => setReleasing(false)}
          onReleased={(revision) => {
            setReleasing(false)
            setReleased(revision)
            // The loom's own revision follows the release, so the next export
            // is stamped with what was frozen.
            ctx.patchLoom({ revision })
            setTimeout(() => setReleased(null), 4000)
          }}
        />
      ) : null}

      {released ? (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-40 flex justify-center">
          <div className="rounded-md border border-emerald-800 bg-emerald-950/90 px-3 py-1.5 text-xs text-emerald-200">
            Revision {released} frozen. Exports still reflect current state; the release is stored.
          </div>
        </div>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.at.x}
          y={menu.at.y}
          title={menuTitle(menu.selection, loom, analysis)}
          items={menuItems(menu.selection)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          onConfirm={() => {
            confirm.run()
            setConfirm(null)
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {splice ? (
        <DistancePrompt
          title={splice.edgeId.startsWith('segment:') ? 'Split bundle' : 'Insert splice'}
          body={
            splice.edgeId.startsWith('segment:')
              ? 'Distance from the start of the bundle. A breakout node is added there and the bundle becomes two.'
              : 'Distance from the source end. The run is cut there and a splice node is added, keeping the total length the same.'
          }
          max={splice.max}
          defaultValue={Math.round(splice.max / 2)}
          onConfirm={(value) => {
            if (splice.edgeId.startsWith('segment:')) {
              ctx.splitSegmentAt(splice.edgeId.slice('segment:'.length), value)
            } else {
              ctx.insertSplice(splice.edgeId, value)
            }
            // Both operations replace the thing that was selected, so holding
            // the old id would leave the inspector reporting it as deleted.
            setSelection(null)
            setSplice(null)
          }}
          onCancel={() => setSplice(null)}
        />
      ) : null}

      {branchTarget ? (
        <DistancePrompt
          title="Attach duplicate"
          body="Distance from the start of the bundle. A breakout is added there and the duplicate's own wires and pigtail attach to it."
          max={branchTarget.max}
          defaultValue={Math.round(branchTarget.max / 2)}
          confirmLabel="Attach here"
          onConfirm={(value) => {
            if (branchFrom) {
              ctx.duplicateBranch(branchFrom, {
                segmentId: branchTarget.segmentId,
                distance_mm: value,
              })
            }
            setBranchFrom(null)
            setBranchTarget(null)
          }}
          onCancel={() => setBranchTarget(null)}
        />
      ) : null}
    </Shell>
  )
}

function menuTitle(selection: Selection, loom: Loom, analysis: LoomAnalysis): string {
  if (!selection) return ''
  if (selection.kind === 'node') {
    return loom.nodes.find((n) => n.id === selection.id)?.name ?? selection.id
  }
  if (selection.kind === 'segment') {
    const load = analysis.segments.find((s) => s.segment.id === selection.id)
    return load?.segment.label ?? selection.id
  }
  return analysis.byEdgeId[selection.id]?.edge.circuitId ?? selection.id
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="relative flex h-screen flex-col overflow-hidden">{children}</div>
}
