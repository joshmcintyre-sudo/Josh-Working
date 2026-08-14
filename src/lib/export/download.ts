/**
 * Browser download helpers.
 *
 * Kept separate from the document builders so the builders stay pure and
 * testable in node, where there is no DOM.
 */

import type { LoomAnalysis } from '~/lib/loom/analysis'
import { bomCsv, cutListCsv } from '~/lib/loom/bom'
import { buildManufacturingDrawing, type DrawingOptions } from './pdf'

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'loom'
  )
}

export function baseFilename(analysis: LoomAnalysis): string {
  return `${slug(analysis.loom.name)}-rev-${slug(analysis.loom.revision)}`
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadDrawing(analysis: LoomAnalysis, options?: DrawingOptions): void {
  const doc = buildManufacturingDrawing(analysis, options)
  downloadBlob(doc.output('blob'), `${baseFilename(analysis)}-drawing.pdf`)
}

export function downloadCutList(analysis: LoomAnalysis): void {
  downloadBlob(
    new Blob([cutListCsv(analysis)], { type: 'text/csv;charset=utf-8' }),
    `${baseFilename(analysis)}-cut-list.csv`,
  )
}

export function downloadBom(analysis: LoomAnalysis): void {
  downloadBlob(
    new Blob([bomCsv(analysis)], { type: 'text/csv;charset=utf-8' }),
    `${baseFilename(analysis)}-bom.csv`,
  )
}
