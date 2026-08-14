/**
 * Formboard view.
 *
 * The board as it gets pinned out, in real millimetres, with a ruled grid at
 * 100 mm and branch points ringed. Nodes drag to match how the loom is actually
 * laid out, which is what makes the exported drawing worth printing.
 *
 * Every run is dimensioned with its authored cut length. Where the drawn path
 * disagrees with that length by more than 10 %, the run is marked — the board
 * is telling you either the pin positions or the length is wrong.
 */

import { useCallback, useRef, useState } from 'react'
import type { LoomAnalysis } from '~/lib/loom/analysis'
import { buildFormboard, type FormboardLayout } from '~/lib/loom/formboard'
import { cn, mm } from '~/lib/utils'
import type { Selection } from './schematic-canvas'
import { Badge } from './ui'

const GRID_MM = 100

export function FormboardView({
  analysis,
  selection,
  onSelect,
  onMoveNode,
}: {
  analysis: LoomAnalysis
  selection: Selection
  onSelect: (s: Selection) => void
  onMoveNode: (id: string, formboardPosition: { x: number; y: number }) => void
}) {
  const layout: FormboardLayout = buildFormboard(analysis)
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [snap, setSnap] = useState(true)

  const board = layout.board
  const pad = 60
  const viewBox = `${-pad} ${-pad} ${board.width_mm + pad * 2} ${board.height_mm + pad * 2}`

  const toBoard = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  const mismatched = new Set(layout.lengthMismatches.map((m) => m.circuitId))

  return (
    <div className="relative h-full w-full overflow-hidden bg-neutral-950">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full touch-none"
        onPointerMove={(e) => {
          if (!drag) return
          const p = toBoard(e.clientX, e.clientY)
          const raw = { x: p.x - drag.dx, y: p.y - drag.dy }
          const step = snap ? 10 : 1
          onMoveNode(drag.id, {
            x: Math.max(0, Math.round(raw.x / step) * step),
            y: Math.max(0, Math.round(raw.y / step) * step),
          })
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onClick={(e) => e.target === svgRef.current && onSelect(null)}
      >
        <defs>
          <pattern id="fbgrid" width={GRID_MM} height={GRID_MM} patternUnits="userSpaceOnUse">
            <path
              d={`M ${GRID_MM} 0 L 0 0 0 ${GRID_MM}`}
              fill="none"
              stroke="#1e1e1e"
              strokeWidth={2}
            />
          </pattern>
        </defs>

        <rect x={0} y={0} width={board.width_mm} height={board.height_mm} fill="url(#fbgrid)" />
        <rect
          x={0}
          y={0}
          width={board.width_mm}
          height={board.height_mm}
          fill="none"
          stroke="#3f3f3f"
          strokeWidth={4}
        />

        {/* Board ruler ticks every 100 mm, labelled every 500 mm. */}
        {Array.from({ length: Math.floor(board.width_mm / GRID_MM) + 1 }, (_, i) => i * GRID_MM)
          .filter((x) => x % 500 === 0)
          .map((x) => (
            <text key={`rx-${x}`} x={x} y={-14} fontSize={22} fill="#525252" textAnchor="middle">
              {x}
            </text>
          ))}
        {Array.from({ length: Math.floor(board.height_mm / GRID_MM) + 1 }, (_, i) => i * GRID_MM)
          .filter((y) => y % 500 === 0)
          .map((y) => (
            <text key={`ry-${y}`} x={-14} y={y + 7} fontSize={22} fill="#525252" textAnchor="end">
              {y}
            </text>
          ))}

        {layout.runs.map((run) => {
          const selected = selection?.kind === 'edge' && selection.id === run.edgeId
          const bad = mismatched.has(run.circuitId)
          const mid = midpoint(run.points)
          return (
            <g
              key={run.edgeId}
              onClick={(e) => {
                e.stopPropagation()
                onSelect({ kind: 'edge', id: run.edgeId })
              }}
              className="cursor-pointer"
            >
              <polyline
                points={run.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="transparent"
                strokeWidth={34}
              />
              <polyline
                points={run.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={selected ? '#38bdf8' : run.color}
                strokeWidth={selected ? 11 : 7}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={run.class === 'ground' ? '26 14' : undefined}
              />
              <text
                x={mid.x}
                y={mid.y - 12}
                fontSize={21}
                textAnchor="middle"
                fill="#d4d4d4"
                style={{ paintOrder: 'stroke', stroke: '#0a0a0a', strokeWidth: 6 }}
              >
                {run.circuitId} · {run.size}
              </text>
              <text
                x={mid.x}
                y={mid.y + 16}
                fontSize={21}
                textAnchor="middle"
                fill={bad ? '#fbbf24' : '#8a8a8a'}
                style={{ paintOrder: 'stroke', stroke: '#0a0a0a', strokeWidth: 6 }}
              >
                {Math.round(run.cutLength_mm)} mm{bad ? ` (drawn ${run.drawnLength_mm})` : ''}
              </text>
            </g>
          )
        })}

        {layout.nodes.map((n) => {
          const selected = selection?.kind === 'node' && selection.id === n.id
          return (
            <g
              key={n.id}
              className="cursor-grab"
              onPointerDown={(e) => {
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                const p = toBoard(e.clientX, e.clientY)
                setDrag({ id: n.id, dx: p.x - n.x_mm, dy: p.y - n.y_mm })
                onSelect({ kind: 'node', id: n.id })
              }}
            >
              {n.isBranchPoint ? (
                <circle
                  cx={n.x_mm}
                  cy={n.y_mm}
                  r={22}
                  fill="none"
                  stroke={selected ? '#38bdf8' : '#a3a3a3'}
                  strokeWidth={4}
                />
              ) : null}
              <circle
                cx={n.x_mm}
                cy={n.y_mm}
                r={11}
                fill={selected ? '#38bdf8' : n.derived ? '#78716c' : '#e5e5e5'}
                stroke="#0a0a0a"
                strokeWidth={3}
              />
              <text
                x={n.x_mm + 28}
                y={n.y_mm - 2}
                fontSize={23}
                fill="#e5e5e5"
                style={{ paintOrder: 'stroke', stroke: '#0a0a0a', strokeWidth: 6 }}
              >
                {n.name}
              </text>
              <text
                x={n.x_mm + 28}
                y={n.y_mm + 22}
                fontSize={19}
                fill="#737373"
                style={{ paintOrder: 'stroke', stroke: '#0a0a0a', strokeWidth: 6 }}
              >
                {n.location} · {n.x_mm},{n.y_mm}
              </text>
            </g>
          )
        })}
      </svg>

      <div className="absolute left-2 top-2 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-400">
        <span>
          Board {mm(board.width_mm)} × {mm(board.height_mm)}
        </span>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          snap 10 mm
        </label>
        {layout.fullyDerived ? (
          <Badge tone="warning">auto-placed</Badge>
        ) : (
          <span className="text-neutral-600">{layout.branchPoints.length} branch points</span>
        )}
      </div>

      {layout.lengthMismatches.length ? (
        <div
          className={cn(
            'absolute bottom-2 left-2 max-w-lg rounded-md border border-amber-900/60',
            'bg-amber-950/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200',
          )}
        >
          {layout.lengthMismatches.length} run
          {layout.lengthMismatches.length === 1 ? '' : 's'} where the pinned distance differs from
          the cut length by more than 10 %. Drag the nodes to match the real layout, or correct the
          length. Cut to the dimensioned length, never to the drawing.
        </div>
      ) : null}
    </div>
  )
}

function midpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 }
  const i = Math.floor((points.length - 1) / 2)
  const a = points[i]!
  const b = points[i + 1]!
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
