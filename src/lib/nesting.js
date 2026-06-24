import { getPolygonBounds, rotatePolygon, translatePolygon } from './dxfParser.js'

// AABB broad-phase check with gap
function aabbOverlap(boundsA, boundsB, gap) {
  return !(
    boundsA.maxX + gap <= boundsB.minX ||
    boundsB.maxX + gap <= boundsA.minX ||
    boundsA.maxY + gap <= boundsB.minY ||
    boundsB.maxY + gap <= boundsA.minY
  )
}

// Separating Axis Theorem narrow-phase
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

function polygonsOverlapSAT(polyA, polyB, gap) {
  // Expand one polygon's projection by gap to enforce clearance
  const axes = [...getAxes(polyA), ...getAxes(polyB)]
  for (const axis of axes) {
    const a = projectPolygon(polyA, axis)
    const b = projectPolygon(polyB, axis)
    if (a.max + gap <= b.min || b.max + gap <= a.min) return false
  }
  return true
}

function insideSheet(bounds, sheetW, sheetH, margin) {
  return (
    bounds.minX >= margin &&
    bounds.minY >= margin &&
    bounds.maxX <= sheetW - margin &&
    bounds.maxY <= sheetH - margin
  )
}

export function nestParts(parts, sheetW, sheetH, gap, margin = 0, allowedRotations = [0, 90, 180, 270]) {
  // Each entry: { polygon, bounds, toolProfileId, partIndex, rotation }
  const placed = []
  const results = []

  // Finer grid for small parts — use smaller of gap or 5mm
  const GRID = Math.max(1, Math.min(5, gap > 0 ? gap / 2 : 3))

  // Sort largest bounding area first
  const sorted = parts
    .map((p, i) => ({ part: p, origIdx: i }))
    .sort((a, b) => {
      const ba = getPolygonBounds(a.part.polygon)
      const bb = getPolygonBounds(b.part.polygon)
      return bb.width * bb.height - ba.width * ba.height
    })

  for (const { part, origIdx } of sorted) {
    let bestPlacement = null

    for (const rot of allowedRotations) {
      if (bestPlacement) break

      const rotPoly = rotatePolygon(part.polygon, rot)
      const rotBounds = getPolygonBounds(rotPoly)

      // Skip if part can't possibly fit on sheet
      if (rotBounds.width + gap * 2 > sheetW - margin * 2) continue
      if (rotBounds.height + gap * 2 > sheetH - margin * 2) continue

      // Scan bottom-left to top-right
      outer:
      for (let gy = margin; gy <= sheetH - margin - rotBounds.height; gy += GRID) {
        for (let gx = margin; gx <= sheetW - margin - rotBounds.width; gx += GRID) {
          const candidate = translatePolygon(rotPoly, gx, gy)
          const candidateBounds = getPolygonBounds(candidate)

          if (!insideSheet(candidateBounds, sheetW, sheetH, margin)) continue

          let collision = false
          for (const p of placed) {
            // Broad phase first — fast AABB check
            if (!aabbOverlap(candidateBounds, p.bounds, gap)) continue
            // Narrow phase — SAT with gap enforcement
            if (polygonsOverlapSAT(candidate, p.polygon, gap)) {
              collision = true
              break
            }
          }

          if (!collision) {
            bestPlacement = {
              polygon: candidate,
              bounds: candidateBounds,
              partIndex: origIdx,
              toolProfileId: part.toolProfileId,
              rotation: rot,
              x: gx,
              y: gy,
            }
            break outer
          }
        }
      }
    }

    if (bestPlacement) {
      placed.push(bestPlacement)
      results.push({ ...bestPlacement, placed: true })
    } else {
      results.push({ placed: false, partIndex: origIdx, toolProfileId: part.toolProfileId })
    }
  }

  return results
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
