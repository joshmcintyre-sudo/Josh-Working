import { getPolygonBounds, rotatePolygon, translatePolygon, normalizePolygon } from './dxfParser.js'

// Separating Axis Theorem polygon intersection test
function projectPolygon(poly, axis) {
  let min = Infinity, max = -Infinity
  for (const p of poly) {
    const dot = p.x * axis.x + p.y * axis.y
    if (dot < min) min = dot
    if (dot > max) max = dot
  }
  return { min, max }
}

function getAxes(poly) {
  const axes = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const edge = { x: b.x - a.x, y: b.y - a.y }
    const len = Math.sqrt(edge.x ** 2 + edge.y ** 2)
    if (len < 1e-9) continue
    axes.push({ x: -edge.y / len, y: edge.x / len })
  }
  return axes
}

function polygonsOverlap(polyA, polyB) {
  const axes = [...getAxes(polyA), ...getAxes(polyB)]
  for (const axis of axes) {
    const a = projectPolygon(polyA, axis)
    const b = projectPolygon(polyB, axis)
    if (a.max <= b.min || b.max <= a.min) return false
  }
  return true
}

function polygonInsideSheet(poly, sheetW, sheetH, margin = 0) {
  for (const p of poly) {
    if (p.x < margin || p.y < margin || p.x > sheetW - margin || p.y > sheetH - margin) {
      return false
    }
  }
  return true
}

// Grid-based bottom-left placement with kerf offset
export function nestParts(parts, sheetW, sheetH, gap, allowedRotations = [0, 90, 180, 270]) {
  const placed = [] // { polygon, partIndex, rotation, x, y }
  const results = []
  const GRID = Math.max(1, Math.min(10, gap > 0 ? gap : 5))

  // Sort parts largest area first
  const sorted = parts
    .map((p, i) => ({ part: p, idx: i }))
    .sort((a, b) => {
      const ba = getPolygonBounds(a.part.polygon)
      const bb = getPolygonBounds(b.part.polygon)
      return bb.width * bb.height - ba.width * ba.height
    })

  for (const { part, idx } of sorted) {
    let bestPlacement = null

    for (const rot of allowedRotations) {
      const rotPoly = rotatePolygon(part.polygon, rot)
      const bounds = getPolygonBounds(rotPoly)

      if (bounds.width + gap > sheetW || bounds.height + gap > sheetH) continue

      let found = false
      // Bottom-left fill: scan y then x
      for (let gy = 0; gy <= sheetH - bounds.height && !found; gy += GRID) {
        for (let gx = 0; gx <= sheetW - bounds.width && !found; gx += GRID) {
          const candidate = translatePolygon(rotPoly, gx, gy)

          if (!polygonInsideSheet(candidate, sheetW, sheetH)) continue

          // Expand by kerf/gap for clearance check
          const gapPoly = expandPolygonSimple(candidate, gap / 2)

          let collision = false
          for (const p of placed) {
            const existingGap = expandPolygonSimple(p.polygon, gap / 2)
            if (polygonsOverlap(gapPoly, existingGap)) {
              collision = true
              break
            }
          }

          if (!collision) {
            bestPlacement = { polygon: candidate, partIndex: idx, rotation: rot, x: gx, y: gy }
            found = true
          }
        }
      }

      if (bestPlacement) break
    }

    if (bestPlacement) {
      placed.push(bestPlacement)
      results.push({ ...bestPlacement, placed: true, partIndex: idx })
    } else {
      results.push({ placed: false, partIndex: idx })
    }
  }

  return results
}

// Simple inward/outward polygon expansion (Minkowski sum approximation)
function expandPolygonSimple(poly, amount) {
  if (amount === 0) return poly
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length
  return poly.map(p => {
    const dx = p.x - cx, dy = p.y - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-9) return p
    return { x: p.x + (dx / len) * amount, y: p.y + (dy / len) * amount }
  })
}

export function computeSheetUtilization(placedResults, sheetW, sheetH) {
  let totalArea = 0
  for (const r of placedResults) {
    if (!r.placed) continue
    totalArea += polygonArea(r.polygon)
  }
  return (totalArea / (sheetW * sheetH)) * 100
}

function polygonArea(poly) {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y
  }
  return Math.abs(area) / 2
}
