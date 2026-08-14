/**
 * Manufacturing drawing.
 *
 * Four pages: the formboard layout, the cut list, the BOM, and the engineering
 * basis. The drawing is printed scaled to fit rather than at 1:1, so every run
 * is dimensioned with its authored cut length and the sheet says so in the
 * title block. Nobody should ever measure a wire off this paper.
 *
 * The basis page exists so a loom handed to a manufacturer overseas can be
 * checked: it records the standards, the ampacity basis, the derating applied
 * and the revision of every reference table the numbers came from.
 */

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { LoomAnalysis } from '~/lib/loom/analysis'
import { buildBom, buildCutList } from '~/lib/loom/bom'
import { CONNECTOR_META, FUSE_META, WIRE_META } from '~/lib/loom/data'
import { ACCESSORY_META } from '~/lib/loom/accessories'
import { buildFormboard, exactFitScale, type FormboardLayout } from '~/lib/loom/formboard'

/** A3 landscape in millimetres — jsPDF works in mm, which suits us here. */
const SHEET = { width: 420, height: 297 }
const MARGIN = 10
const TITLE_BLOCK_H = 26

export interface DrawingOptions {
  /** Who the drawing is for. Printed in the title block. */
  preparedFor?: string
  drawnBy?: string
  /** Injected so the output is deterministic under test. */
  date?: Date
}

export function buildManufacturingDrawing(
  analysis: LoomAnalysis,
  options: DrawingOptions = {},
): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
  const layout = buildFormboard(analysis)
  const date = options.date ?? new Date()

  drawFormboardPage(doc, analysis, layout, options, date)

  doc.addPage()
  drawCutListPage(doc, analysis, options, date)

  doc.addPage()
  drawBomPage(doc, analysis, options, date)

  doc.addPage()
  drawBasisPage(doc, analysis, options, date)

  return doc
}

/* ------------------------------- title block ------------------------------ */

function titleBlock(
  doc: jsPDF,
  analysis: LoomAnalysis,
  options: DrawingOptions,
  date: Date,
  sheetTitle: string,
  sheetNumber: string,
  scaleNote: string,
) {
  const y = SHEET.height - MARGIN - TITLE_BLOCK_H
  const w = SHEET.width - MARGIN * 2

  doc.setDrawColor(60, 60, 60)
  doc.setLineWidth(0.4)
  doc.rect(MARGIN, y, w, TITLE_BLOCK_H)

  const cols = [0, 120, 200, 268, 336, w]
  for (const c of cols.slice(1, -1)) doc.line(MARGIN + c, y, MARGIN + c, y + TITLE_BLOCK_H)

  const cell = (i: number, label: string, value: string, size = 9) => {
    const x = MARGIN + cols[i]! + 3
    doc.setFontSize(6)
    doc.setTextColor(120, 120, 120)
    doc.text(label.toUpperCase(), x, y + 5)
    doc.setFontSize(size)
    doc.setTextColor(20, 20, 20)
    doc.text(value, x, y + 13)
  }

  cell(0, 'Loom', analysis.loom.name, 12)
  doc.setFontSize(7)
  doc.setTextColor(90, 90, 90)
  doc.text(analysis.loom.description ?? '', MARGIN + 3, y + 20, {
    maxWidth: cols[1]! - 6,
  })

  cell(1, 'Sheet', sheetTitle)
  doc.setFontSize(7)
  doc.setTextColor(90, 90, 90)
  doc.text(sheetNumber, MARGIN + cols[1]! + 3, y + 20)

  cell(2, 'Revision', analysis.loom.revision, 12)
  cell(3, 'Scale', scaleNote, 8)
  cell(4, 'Date', date.toISOString().slice(0, 10))

  doc.setFontSize(6)
  doc.setTextColor(120, 120, 120)
  const meta = [
    options.drawnBy ? `Drawn: ${options.drawnBy}` : null,
    options.preparedFor ? `For: ${options.preparedFor}` : null,
    `System: ${analysis.loom.settings.systemVoltage_v} V DC`,
  ]
    .filter(Boolean)
    .join('   ')
  doc.text(meta, MARGIN + cols[4]! + 3, y + 20)
}

/* ----------------------------- formboard page ----------------------------- */

function drawFormboardPage(
  doc: jsPDF,
  analysis: LoomAnalysis,
  layout: FormboardLayout,
  options: DrawingOptions,
  date: Date,
) {
  const drawArea = {
    x: MARGIN,
    y: MARGIN,
    w: SHEET.width - MARGIN * 2,
    h: SHEET.height - MARGIN * 2 - TITLE_BLOCK_H - 4,
  }
  const scale = exactFitScale(layout.board, {
    width_mm: drawArea.w - 10,
    height_mm: drawArea.h - 20,
  })
  // Centre whichever axis has slack after fitting.
  const drawnW = layout.board.width_mm * scale.ratio
  const drawnH = layout.board.height_mm * scale.ratio
  const originX = drawArea.x + (drawArea.w - drawnW) / 2
  const originY = drawArea.y + 6 + Math.max(0, (drawArea.h - 14 - drawnH) / 2)
  const toX = (mm: number) => originX + mm * scale.ratio
  const toY = (mm: number) => originY + mm * scale.ratio

  // Board outline.
  doc.setDrawColor(170, 170, 170)
  doc.setLineWidth(0.3)
  doc.rect(toX(0), toY(0), layout.board.width_mm * scale.ratio, layout.board.height_mm * scale.ratio)
  doc.setFontSize(6)
  doc.setTextColor(150, 150, 150)
  doc.text(
    `Board ${layout.board.width_mm} x ${layout.board.height_mm} mm`,
    toX(0),
    toY(0) - 2,
  )

  // Runs.
  for (const run of layout.runs) {
    const rgb = hexToRgb(run.color)
    doc.setDrawColor(rgb[0], rgb[1], rgb[2])
    doc.setLineWidth(run.class === 'ground' ? 0.5 : 0.8)
    if (run.class === 'ground') doc.setLineDashPattern([1.5, 1], 0)
    else doc.setLineDashPattern([], 0)
    for (let i = 1; i < run.points.length; i++) {
      const a = run.points[i - 1]!
      const b = run.points[i]!
      doc.line(toX(a.x), toY(a.y), toX(b.x), toY(b.y))
    }
    doc.setLineDashPattern([], 0)

    // Dimension the run with its cut length. This is the number that matters —
    // the drawing is not to scale for measuring.
    //
    // Labels are set along the run and offset perpendicular to it, the way a
    // dimension is annotated on a drawing. Horizontal labels collide badly once
    // a loom has more than a handful of branches.
    const mid = midpoint(run.points)
    const seg = labelSegment(run.points)
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    const len = Math.hypot(dx, dy) || 1
    // jsPDF rotates counter-clockwise while y increases downward, hence the sign.
    let angle = (-Math.atan2(dy, dx) * 180) / Math.PI
    if (angle > 90) angle -= 180
    if (angle < -90) angle += 180
    // Unit normal, always pointing "up" the page so the two lines never swap.
    const nx = (-dy / len) * (dy > 0 ? -1 : 1)
    const ny = (dx / len) * (dy > 0 ? -1 : 1)
    const cx = toX(mid.x)
    const cy = toY(mid.y)

    doc.setFontSize(5.2)
    doc.setTextColor(40, 40, 40)
    doc.text(`${run.circuitId}  ${run.size}`, cx + nx * 2.1, cy + ny * 2.1, {
      align: 'center',
      baseline: 'middle',
      angle,
    })
    doc.setTextColor(110, 110, 110)
    doc.text(`${Math.round(run.cutLength_mm)} mm`, cx - nx * 2.1, cy - ny * 2.1, {
      align: 'center',
      baseline: 'middle',
      angle,
    })
  }

  // Nodes.
  for (const node of layout.nodes) {
    const x = toX(node.x_mm)
    const y = toY(node.y_mm)
    if (node.isBranchPoint) {
      doc.setFillColor(20, 20, 20)
      doc.circle(x, y, 1.8, 'F')
      doc.setDrawColor(20, 20, 20)
      doc.setLineWidth(0.3)
      doc.circle(x, y, 3.2, 'S')
    } else {
      doc.setFillColor(70, 70, 70)
      doc.circle(x, y, 1.4, 'F')
    }
    doc.setFontSize(6)
    doc.setTextColor(20, 20, 20)
    doc.text(node.name, x + 4.5, y - 0.4, { maxWidth: 46 })
    if (node.location) {
      doc.setFontSize(5)
      doc.setTextColor(130, 130, 130)
      doc.text(node.location, x + 4.5, y + 2.8, { maxWidth: 46 })
    }
  }

  // Scale bar — the only legitimate way to read a distance off this sheet.
  drawScaleBar(doc, drawArea, scale.ratio)

  // Legend and the honesty note about scale.
  doc.setFontSize(5.5)
  doc.setTextColor(110, 110, 110)
  doc.text(
    'Solid = supply  ·  Dashed = return  ·  Ringed dot = branch point  ·  ' +
      'NOT TO SCALE FOR MEASUREMENT: cut to the dimensioned length, not to the drawing.',
    drawArea.x + 5,
    drawArea.y + drawArea.h - 1,
  )

  if (layout.fullyDerived) {
    doc.setTextColor(190, 100, 0)
    doc.text(
      'Board positions are auto-derived from the schematic and have not been pinned out.',
      drawArea.x + 5,
      drawArea.y + drawArea.h - 5,
    )
  }

  titleBlock(
    doc,
    analysis,
    options,
    date,
    'Formboard layout',
    'Sheet 1 of 4',
    scale.label,
  )
}

function drawScaleBar(
  doc: jsPDF,
  area: { x: number; y: number; w: number; h: number },
  ratio: number,
) {
  // A bar representing a round number of real millimetres.
  const targetPaper = 40
  const realMm = niceRound(targetPaper / ratio)
  const paperLen = realMm * ratio
  const x = area.x + area.w - paperLen - 6
  const y = area.y + area.h - 10

  doc.setDrawColor(60, 60, 60)
  doc.setLineWidth(0.3)
  doc.setFillColor(60, 60, 60)
  const segments = 4
  for (let i = 0; i < segments; i++) {
    const sx = x + (paperLen / segments) * i
    const sw = paperLen / segments
    if (i % 2 === 0) doc.rect(sx, y, sw, 1.6, 'F')
    else doc.rect(sx, y, sw, 1.6, 'S')
  }
  doc.setFontSize(5.5)
  doc.setTextColor(60, 60, 60)
  doc.text('0', x, y - 1)
  doc.text(`${realMm} mm`, x + paperLen, y - 1, { align: 'right' })
}

function niceRound(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const m of [1, 2, 5]) {
    if (value <= m * magnitude) return m * magnitude
  }
  return 10 * magnitude
}

/* ------------------------------- cut list --------------------------------- */

function drawCutListPage(
  doc: jsPDF,
  analysis: LoomAnalysis,
  options: DrawingOptions,
  date: Date,
) {
  const rows = buildCutList(analysis)
  autoTable(doc, {
    startY: MARGIN + 6,
    margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + TITLE_BLOCK_H + 6 },
    head: [
      ['Wire ref', 'From', 'To', 'Cut (mm)', 'Wire', 'Insulation', 'Amps', 'Drop %', 'Driven by', 'Fuse'],
    ],
    body: rows.map((r) => [
      r.wireRef,
      `${r.from}\n${r.fromLocation}`,
      `${r.to}\n${r.toLocation}`,
      String(r.length_mm),
      r.size,
      r.insulation,
      r.current_a.toFixed(1),
      r.voltageDropPct.toFixed(2),
      r.limitingConstraint.replace(/_/g, ' '),
      r.fuse,
    ]),
    styles: { fontSize: 6.5, cellPadding: 1.2, lineColor: 210, lineWidth: 0.1 },
    headStyles: { fillColor: [40, 40, 40], fontSize: 6.5 },
    columnStyles: {
      0: { cellWidth: 20, fontStyle: 'bold' },
      3: { cellWidth: 18, halign: 'right' },
      4: { cellWidth: 24 },
      6: { cellWidth: 16, halign: 'right' },
      7: { cellWidth: 16, halign: 'right' },
      8: { cellWidth: 28 },
    },
  })
  titleBlock(doc, analysis, options, date, 'Cut list', 'Sheet 2 of 4', 'n/a')
}

/* ---------------------------------- BOM ----------------------------------- */

function drawBomPage(doc: jsPDF, analysis: LoomAnalysis, options: DrawingOptions, date: Date) {
  const bom = buildBom(analysis)
  const body: (string | { content: string; colSpan?: number; styles?: object })[][] = []
  for (const group of bom.groups) {
    body.push([
      {
        content: group.title.toUpperCase(),
        colSpan: 5,
        styles: { fillColor: [235, 235, 235], fontStyle: 'bold', fontSize: 6.5 },
      },
    ])
    for (const line of group.lines) {
      body.push([
        line.description,
        line.partNumber ?? (line.needsPartNumber ? 'CONFIRM FROM CATALOGUE' : ''),
        String(line.quantity),
        line.unit ?? 'ea',
        line.note ?? '',
      ])
    }
  }

  autoTable(doc, {
    startY: MARGIN + 6,
    margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + TITLE_BLOCK_H + 6 },
    head: [['Item', 'Part number', 'Qty', 'Unit', 'Note']],
    body,
    styles: { fontSize: 6.5, cellPadding: 1.2, lineColor: 210, lineWidth: 0.1 },
    headStyles: { fillColor: [40, 40, 40], fontSize: 6.5 },
    columnStyles: {
      0: { cellWidth: 110 },
      1: { cellWidth: 50 },
      2: { cellWidth: 16, halign: 'right' },
      3: { cellWidth: 14 },
    },
  })

  if (bom.unresolvedPartNumbers > 0) {
    const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5
    doc.setFontSize(7)
    doc.setTextColor(170, 90, 0)
    doc.text(
      `${bom.unresolvedPartNumbers} line(s) marked CONFIRM FROM CATALOGUE. These are not ` +
        `orderable as printed — confirm the part number against the current supplier catalogue first.`,
      MARGIN,
      y,
      { maxWidth: SHEET.width - MARGIN * 2 },
    )
  }

  titleBlock(doc, analysis, options, date, 'Bill of materials', 'Sheet 3 of 4', 'n/a')
}

/* --------------------------------- basis ---------------------------------- */

function drawBasisPage(doc: jsPDF, analysis: LoomAnalysis, options: DrawingOptions, date: Date) {
  const s = analysis.loom.settings
  const basisLabel =
    s.ampacityBasis === 'as_nzs_3808'
      ? WIRE_META.ampacityBases.as_nzs_3808.label
      : WIRE_META.ampacityBases.sae_j1128.label

  autoTable(doc, {
    startY: MARGIN + 6,
    margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + TITLE_BLOCK_H + 6 },
    head: [['Engineering basis', '']],
    body: [
      ['System voltage', `${s.systemVoltage_v} V DC`],
      ['Ampacity basis', basisLabel],
      ['Conductor family', s.defaultFamily === 'awg' ? 'AWG / B&S' : 'Metric mm²'],
      ['Default ambient', `${s.defaultAmbient_c} °C`],
      ['Default insulation', s.defaultInsulationId],
      ['Minimum hand-crimp size', s.minimumSizeId],
      ['Service loop allowance', `${s.serviceLoop_mm} mm per run`],
      [
        'Wire sizing rule',
        'Smallest standard size where current <= derated ampacity, voltage drop <= the class ' +
          'budget, and (on a protected run) a standard fuse rating exists between 1.25 x current ' +
          'and the conductor rating.',
      ],
      [
        'Voltage drop budget',
        'Power 3 %, charging 2 %, signal 10 %, starter 5 % of system voltage.',
      ],
      ['Fuse rule', FUSE_META.selectionRule.steps.join(' ')],
      ['Bundling derate', WIRE_META.bundlingFactors.note as string],
      ['Ambient derate', WIRE_META.ambientFactors.note as string],
      ['Connector derate', CONNECTOR_META.deratingRule.note],
      ['Standards', WIRE_META.standards.join('; ')],
      [
        'Reference data revisions',
        `wire ${WIRE_META.revision}; connectors ${CONNECTOR_META.revision}; ` +
          `fuses ${FUSE_META.revision}; accessories ${ACCESSORY_META.revision}`,
      ],
      ['Part number policy', CONNECTOR_META.pnPolicy.note],
    ],
    styles: { fontSize: 7, cellPadding: 1.6, lineColor: 210, lineWidth: 0.1, valign: 'top' },
    headStyles: { fillColor: [40, 40, 40], fontSize: 7 },
    columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
  })

  const issues = analysis.issues.filter((i) => i.severity !== 'info')
  if (issues.length) {
    autoTable(doc, {
      startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6,
      margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + TITLE_BLOCK_H + 6 },
      head: [['', 'Outstanding checks']],
      body: issues.map((i) => [i.severity.toUpperCase(), `${i.message}${i.remedy ? ` — ${i.remedy}` : ''}`]),
      styles: { fontSize: 6.5, cellPadding: 1.2, lineColor: 210, lineWidth: 0.1 },
      headStyles: { fillColor: [40, 40, 40], fontSize: 6.5 },
      columnStyles: { 0: { cellWidth: 20, fontStyle: 'bold' } },
    })
  }

  titleBlock(doc, analysis, options, date, 'Engineering basis', 'Sheet 4 of 4', 'n/a')
}

/* -------------------------------- helpers --------------------------------- */

/** The polyline segment the label sits on, so it can be aligned to it. */
function labelSegment(points: { x: number; y: number }[]): {
  a: { x: number; y: number }
  b: { x: number; y: number }
} {
  if (points.length < 2) {
    const only = points[0] ?? { x: 0, y: 0 }
    return { a: only, b: { x: only.x + 1, y: only.y } }
  }
  const i = Math.floor((points.length - 1) / 2)
  return { a: points[i]!, b: points[i + 1]! }
}

function midpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 }
  const i = Math.floor((points.length - 1) / 2)
  const a = points[i]!
  const b = points[i + 1]!
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return [80, 80, 80]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
