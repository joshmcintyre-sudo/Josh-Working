/**
 * Formboard layout.
 *
 * The formboard is the physical board the loom is pinned out on before it is
 * taped. Node positions here are real millimetres on that board, not canvas
 * coordinates, and every run carries its authored cut length.
 *
 * The drawing is printed scaled to fit a sheet rather than at 1:1, so nobody
 * can lay a wire against it and read a length off the paper. Two consequences
 * are handled explicitly:
 *
 *   1. Every run is dimensioned with its authored length. That number, not the
 *      paper, is what gets cut.
 *   2. Where the straight-line distance between two pinned nodes disagrees with
 *      the authored length, the layout is reporting something real — either the
 *      board positions are wrong or the run has slack that is not drawn. Both
 *      are surfaced rather than silently reconciled.
 */

import type { EdgeAnalysis, LoomAnalysis } from './analysis'
import type { Loom, LoomNode, NodeKind } from './types'

export interface FormboardNode {
  id: string
  name: string
  kind: NodeKind
  location: string
  x_mm: number
  y_mm: number
  /** True when the position was scaled off the schematic, not placed by hand. */
  derived: boolean
  /** How many runs terminate here. Three or more makes it a branch point. */
  degree: number
  isBranchPoint: boolean
}

export interface FormboardRun {
  edgeId: string
  circuitId: string
  label: string
  /** Polyline in board millimetres. Two points unless the run has routing. */
  points: { x: number; y: number }[]
  /** The authored run length — the number that gets cut. */
  cutLength_mm: number
  /** Straight-line distance the drawing actually shows. */
  drawnLength_mm: number
  size: string
  color: string
  class: string
  /** Positive when the run is longer than the board path drawn for it. */
  slack_mm: number
}

export interface FormboardLayout {
  board: { width_mm: number; height_mm: number }
  nodes: FormboardNode[]
  runs: FormboardRun[]
  branchPoints: FormboardNode[]
  /** Runs whose drawn path disagrees with the authored length by over 10 %. */
  lengthMismatches: { circuitId: string; cutLength_mm: number; drawnLength_mm: number }[]
  /** True when no node had a hand-placed board position. */
  fullyDerived: boolean
}

export const DEFAULT_BOARD = { width_mm: 2400, height_mm: 1200 }
const MARGIN_MM = 80

/**
 * Board positions for every node. Hand-placed positions win; the rest are
 * scaled off the schematic so a new loom opens with a usable starting layout
 * that can then be dragged to match how it is actually pinned.
 */
export function deriveFormboardPositions(loom: Loom): Map<string, { x: number; y: number; derived: boolean }> {
  const board = loom.formboard ?? DEFAULT_BOARD
  const out = new Map<string, { x: number; y: number; derived: boolean }>()
  const needsDeriving = loom.nodes.filter((n) => !n.formboardPosition)

  for (const n of loom.nodes) {
    if (n.formboardPosition) {
      out.set(n.id, { ...n.formboardPosition, derived: false })
    }
  }
  if (needsDeriving.length === 0) return out

  // Scale the schematic bounding box into the board, preserving aspect ratio so
  // the layout is not distorted before anyone drags it.
  const xs = loom.nodes.map((n) => n.position.x)
  const ys = loom.nodes.map((n) => n.position.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const usableW = Math.max(1, board.width_mm - MARGIN_MM * 2)
  const usableH = Math.max(1, board.height_mm - MARGIN_MM * 2)
  const scale = Math.min(usableW / spanX, usableH / spanY)
  // Centre whichever axis has slack.
  const offsetX = MARGIN_MM + (usableW - spanX * scale) / 2
  const offsetY = MARGIN_MM + (usableH - spanY * scale) / 2

  for (const n of needsDeriving) {
    out.set(n.id, {
      x: Math.round(offsetX + (n.position.x - minX) * scale),
      y: Math.round(offsetY + (n.position.y - minY) * scale),
      derived: true,
    })
  }
  return out
}

function polylineLength(points: { x: number; y: number }[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

export function buildFormboard(analysis: LoomAnalysis): FormboardLayout {
  const loom = analysis.loom
  const board = loom.formboard ?? DEFAULT_BOARD
  const positions = deriveFormboardPositions(loom)

  const degree = new Map<string, number>()
  for (const e of loom.edges) {
    degree.set(e.fromNodeId, (degree.get(e.fromNodeId) ?? 0) + 1)
    degree.set(e.toNodeId, (degree.get(e.toNodeId) ?? 0) + 1)
  }

  const nodes: FormboardNode[] = loom.nodes.map((n: LoomNode) => {
    const p = positions.get(n.id) ?? { x: MARGIN_MM, y: MARGIN_MM, derived: true }
    const d = degree.get(n.id) ?? 0
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      location: n.location,
      x_mm: p.x,
      y_mm: p.y,
      derived: p.derived,
      degree: d,
      // Three or more runs meeting is where the loom physically splits, and it
      // is what the builder needs marked on the board.
      isBranchPoint: d >= 3,
    }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const runs: FormboardRun[] = analysis.edges.map((ea: EdgeAnalysis) => {
    const from = byId.get(ea.edge.fromNodeId)!
    const to = byId.get(ea.edge.toNodeId)!
    const points = ea.edge.routing?.length
      ? [{ x: from.x_mm, y: from.y_mm }, ...ea.edge.routing, { x: to.x_mm, y: to.y_mm }]
      : [
          { x: from.x_mm, y: from.y_mm },
          { x: to.x_mm, y: to.y_mm },
        ]
    const drawn = polylineLength(points)
    return {
      edgeId: ea.edge.id,
      circuitId: ea.edge.circuitId,
      label: ea.edge.label ?? ea.edge.circuitId,
      points,
      cutLength_mm: ea.effectiveLength_mm,
      drawnLength_mm: Math.round(drawn),
      size: ea.sizing.size?.label ?? 'UNSIZED',
      color: ea.color,
      class: ea.edge.class,
      slack_mm: Math.round(ea.effectiveLength_mm - drawn),
    }
  })

  const lengthMismatches = runs
    .filter((r) => r.drawnLength_mm > 0 && Math.abs(r.slack_mm) / r.cutLength_mm > 0.1)
    .map((r) => ({
      circuitId: r.circuitId,
      cutLength_mm: Math.round(r.cutLength_mm),
      drawnLength_mm: r.drawnLength_mm,
    }))

  return {
    board,
    nodes,
    runs,
    branchPoints: nodes.filter((n) => n.isBranchPoint),
    lengthMismatches,
    fullyDerived: nodes.every((n) => n.derived),
  }
}

/**
 * Exact scale to fill a sheet. Used for the manufacturing drawing, which is
 * explicitly not for measurement — distances come off the printed scale bar, so
 * filling the sheet is worth more than landing on a round ratio.
 */
export function exactFitScale(
  board: { width_mm: number; height_mm: number },
  sheet: { width_mm: number; height_mm: number },
): { ratio: number; denominator: number; label: string } {
  const ratio = Math.min(sheet.width_mm / board.width_mm, sheet.height_mm / board.height_mm)
  const denominator = 1 / ratio
  const rounded = denominator < 10 ? denominator.toFixed(1) : denominator.toFixed(0)
  return {
    ratio,
    denominator,
    label: denominator <= 1.02 ? '1:1' : `1:${rounded} (scaled to fit)`,
  }
}

/**
 * Nearest standard drawing scale that fits (1:4, 1:10 …) — a ratio someone
 * would write on a drawing. Kept for output that has to sit on a round scale.
 */
export function fitScale(
  board: { width_mm: number; height_mm: number },
  sheet: { width_mm: number; height_mm: number },
): { ratio: number; denominator: number } {
  const raw = Math.min(sheet.width_mm / board.width_mm, sheet.height_mm / board.height_mm)
  const NICE = [1, 2, 2.5, 4, 5, 10, 20, 25, 50, 100]
  const needed = 1 / raw
  const denominator = NICE.find((d) => d >= needed) ?? Math.ceil(needed)
  return { ratio: 1 / denominator, denominator }
}
