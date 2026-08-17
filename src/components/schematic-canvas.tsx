/**
 * Schematic canvas.
 *
 * An SVG node/edge editor. Nodes drag, edges are drawn by clicking a node's
 * connect handle and then a target. Every run is labelled with the calculated
 * gauge and current, so the engineering is visible while you draw rather than
 * hidden behind a panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EdgeAnalysis, LoomAnalysis } from '~/lib/loom/analysis'
import type { Loom, LoomNode, NodeKind } from '~/lib/loom/types'
import { amps, cn } from '~/lib/utils'

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'segment'; id: string }
  | null

const NODE_W = 132
const NODE_H = 44

const KIND_STYLE: Record<NodeKind, { fill: string; stroke: string; label: string }> = {
  source: { fill: '#3f1d1d', stroke: '#d81f26', label: 'SRC' },
  load: { fill: '#1b2a3a', stroke: '#4a90d9', label: 'LOAD' },
  splice: { fill: '#2a2416', stroke: '#c9a227', label: 'SPL' },
  ground: { fill: '#1f1f1f', stroke: '#8a8a8a', label: 'GND' },
  connector: { fill: '#20302a', stroke: '#3fae72', label: 'CON' },
  termination: { fill: '#26262b', stroke: '#8a8a95', label: 'CUT' },
}

interface Props {
  loom: Loom
  analysis: LoomAnalysis
  selection: Selection
  onSelect: (s: Selection) => void
  onMoveNode: (id: string, position: { x: number; y: number }) => void
  onConnect: (fromId: string, toId: string) => void
  onContextMenu?: (selection: Selection, at: { x: number; y: number }) => void
  /** Start a link from this node, e.g. when the quick menu begins a bundle. */
  linkFromNodeId?: string | null
  onLinkCancel?: () => void
}

export function SchematicCanvas({
  loom,
  analysis,
  selection,
  onSelect,
  onMoveNode,
  onConnect,
  onContextMenu,
  linkFromNodeId,
  onLinkCancel,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  // A link can also be started from outside, by the quick-action menu.
  useEffect(() => {
    if (linkFromNodeId !== undefined) setLinkFrom(linkFromNodeId)
  }, [linkFromNodeId])
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return {
        x: (clientX - rect.left - view.x) / view.scale,
        y: (clientY - rect.top - view.y) / view.scale,
      }
    },
    [view],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY)
      if (linkFrom) setPointer(p)
      if (drag) onMoveNode(drag.id, { x: Math.round(p.x - drag.dx), y: Math.round(p.y - drag.dy) })
    },
    [drag, linkFrom, onMoveNode, toCanvas],
  )

  // Escape cancels a half-drawn run rather than leaving it dangling.
  useEffect(() => {
    if (!linkFrom) return
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkFrom(null)
        setPointer(null)
        onLinkCancel?.()
      }
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [linkFrom, onLinkCancel])

  const nodeById = new Map(loom.nodes.map((n) => [n.id, n]))
  const centre = (n: LoomNode) => ({ x: n.position.x + NODE_W / 2, y: n.position.y + NODE_H / 2 })

  return (
    <div className="relative h-full w-full overflow-hidden bg-neutral-950">
      <svg
        ref={svgRef}
        className={cn('h-full w-full touch-none', drag ? 'cursor-grabbing' : 'cursor-default')}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onClick={(e) => {
          if (e.target === svgRef.current) {
            onSelect(null)
            setLinkFrom(null)
          }
        }}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return
          e.preventDefault()
          setView((v) => ({ ...v, scale: Math.min(2.5, Math.max(0.3, v.scale - e.deltaY * 0.002)) }))
        }}
      >
        <defs>
          <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1c1c1c" strokeWidth="1" />
          </pattern>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />

        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {analysis.edges.map((ea) => {
            const from = nodeById.get(ea.edge.fromNodeId)
            const to = nodeById.get(ea.edge.toNodeId)
            if (!from || !to) return null
            return (
              <EdgeShape
                key={ea.edge.id}
                ea={ea}
                a={centre(from)}
                b={centre(to)}
                selected={selection?.kind === 'edge' && selection.id === ea.edge.id}
                hasError={analysis.issues.some(
                  (i) => i.edgeId === ea.edge.id && i.severity === 'error',
                )}
                onSelect={() => onSelect({ kind: 'edge', id: ea.edge.id })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onSelect({ kind: 'edge', id: ea.edge.id })
                  onContextMenu?.({ kind: 'edge', id: ea.edge.id }, { x: e.clientX, y: e.clientY })
                }}
              />
            )
          })}

          {linkFrom && pointer
            ? (() => {
                const from = nodeById.get(linkFrom)
                if (!from) return null
                const a = centre(from)
                return (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={pointer.x}
                    y2={pointer.y}
                    stroke="#38bdf8"
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    pointerEvents="none"
                  />
                )
              })()
            : null}

          {loom.nodes.map((n) => (
            <NodeShape
              key={n.id}
              node={n}
              selected={selection?.kind === 'node' && selection.id === n.id}
              linking={linkFrom === n.id}
              hasError={analysis.issues.some((i) => i.nodeId === n.id && i.severity === 'error')}
              onPointerDown={(e) => {
                if (linkFrom) return
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                const p = toCanvas(e.clientX, e.clientY)
                setDrag({ id: n.id, dx: p.x - n.position.x, dy: p.y - n.position.y })
                onSelect({ kind: 'node', id: n.id })
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (!linkFrom) return onSelect({ kind: 'node', id: n.id })
                if (linkFrom !== n.id) onConnect(linkFrom, n.id)
                setLinkFrom(null)
                setPointer(null)
              }}
              onStartLink={(e) => {
                e.stopPropagation()
                setLinkFrom(n.id)
                setPointer(centre(n))
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onSelect({ kind: 'node', id: n.id })
                onContextMenu?.({ kind: 'node', id: n.id }, { x: e.clientX, y: e.clientY })
              }}
            />
          ))}
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-2 left-2 flex gap-2 text-[11px] text-neutral-600">
        <span>{linkFrom ? 'Click a target node to connect — Esc to cancel' : 'Drag to move · ⌘-scroll to zoom'}</span>
      </div>
      <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/90 px-1.5 py-1 text-[11px] text-neutral-400">
        <button
          className="px-1.5 hover:text-neutral-100"
          onClick={() => setView((v) => ({ ...v, scale: Math.max(0.3, v.scale - 0.15) }))}
        >
          −
        </button>
        <span className="w-10 text-center tabular-nums">{Math.round(view.scale * 100)}%</span>
        <button
          className="px-1.5 hover:text-neutral-100"
          onClick={() => setView((v) => ({ ...v, scale: Math.min(2.5, v.scale + 0.15) }))}
        >
          +
        </button>
        <button
          className="ml-1 border-l border-neutral-800 pl-2 hover:text-neutral-100"
          onClick={() => setView({ x: 0, y: 0, scale: 1 })}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

function NodeShape({
  node,
  selected,
  linking,
  hasError,
  onPointerDown,
  onClick,
  onStartLink,
  onContextMenu,
}: {
  node: LoomNode
  selected: boolean
  linking: boolean
  hasError: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onClick: (e: React.MouseEvent) => void
  onStartLink: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const style = KIND_STYLE[node.kind]
  const current = node.load?.continuousCurrent_a ?? node.source?.capacity_a
  return (
    <g
      transform={`translate(${node.position.x} ${node.position.y})`}
      className="cursor-grab"
      onContextMenu={onContextMenu}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill={style.fill}
        stroke={hasError ? '#ef4444' : selected ? '#38bdf8' : style.stroke}
        strokeWidth={selected || hasError ? 2 : 1.25}
        onPointerDown={onPointerDown}
        onClick={onClick}
      />
      <text
        x={8}
        y={16}
        fontSize={9}
        fill={style.stroke}
        fontFamily="ui-monospace, monospace"
        pointerEvents="none"
      >
        {style.label}
      </text>
      <text x={8} y={30} fontSize={11} fill="#e5e5e5" pointerEvents="none">
        {node.name.length > 19 ? `${node.name.slice(0, 18)}…` : node.name}
      </text>
      {current !== undefined ? (
        <text
          x={NODE_W - 8}
          y={16}
          fontSize={9}
          textAnchor="end"
          fill="#a3a3a3"
          fontFamily="ui-monospace, monospace"
          pointerEvents="none"
        >
          {amps(current)}
        </text>
      ) : null}
      <text x={8} y={40} fontSize={8.5} fill="#737373" pointerEvents="none">
        {node.location.length > 26 ? `${node.location.slice(0, 25)}…` : node.location}
      </text>
      <circle
        cx={NODE_W}
        cy={NODE_H / 2}
        r={6}
        fill={linking ? '#38bdf8' : '#262626'}
        stroke="#525252"
        className="cursor-crosshair"
        onClick={onStartLink}
      >
        <title>Draw a run from here</title>
      </circle>
    </g>
  )
}

function EdgeShape({
  ea,
  a,
  b,
  selected,
  hasError,
  onSelect,
  onContextMenu,
}: {
  ea: EdgeAnalysis
  a: { x: number; y: number }
  b: { x: number; y: number }
  selected: boolean
  hasError: boolean
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  // A gentle S-curve reads better than a straight line when nodes are stacked.
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.4)
  const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 8 }
  const stroke = hasError ? '#ef4444' : selected ? '#38bdf8' : ea.color
  const label = ea.sizing.size
    ? `${ea.edge.circuitId} · ${ea.sizing.size.label} · ${amps(ea.current_a)}`
    : `${ea.edge.circuitId} · unsized`

  return (
    <g onClick={onSelect} onContextMenu={onContextMenu} className="cursor-pointer">
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={selected ? 3 : Math.min(5, 1.4 + (ea.sizing.size?.area_mm2 ?? 1) ** 0.35)}
        strokeLinecap="round"
        color={stroke}
        markerEnd="url(#arrow)"
        opacity={ea.edge.class === 'ground' ? 0.85 : 1}
        strokeDasharray={ea.edge.class === 'ground' ? '7 3' : undefined}
      />
      <text
        x={mid.x}
        y={mid.y}
        fontSize={9}
        textAnchor="middle"
        fill={hasError ? '#fca5a5' : '#a3a3a3'}
        fontFamily="ui-monospace, monospace"
        pointerEvents="none"
        style={{ paintOrder: 'stroke', stroke: '#0a0a0a', strokeWidth: 3 }}
      >
        {label}
      </text>
    </g>
  )
}
