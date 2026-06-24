import DxfParser from 'dxf-parser'

const ARC_SEGMENTS = 24
const SPLINE_SEGMENTS = 32
const CHAIN_TOL = 0.5  // mm tolerance for endpoint matching

// ── Arc helpers ──────────────────────────────────────────────────────────────

function arcPoints(cx, cy, radius, startDeg, endDeg, ccw = false) {
  const pts = []
  let s = (startDeg * Math.PI) / 180
  let e = (endDeg * Math.PI) / 180
  if (!ccw && e <= s + 1e-9) e += Math.PI * 2
  if (ccw && e >= s - 1e-9) e -= Math.PI * 2
  const steps = Math.max(4, Math.round(Math.abs(e - s) * (ARC_SEGMENTS / (Math.PI * 2))))
  for (let i = 0; i <= steps; i++) {
    const t = s + ((e - s) * i) / steps
    pts.push({ x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) })
  }
  return pts
}

// ── Spline evaluation (cubic B-spline via de Boor) ───────────────────────────

function evaluateBSpline(controlPoints, degree, knots, t) {
  const n = controlPoints.length - 1
  const d = degree

  // Find knot span
  let k = d
  for (let i = d; i < knots.length - d - 1; i++) {
    if (t >= knots[i] && t < knots[i + 1]) { k = i; break }
  }
  if (t >= knots[knots.length - d - 1]) k = knots.length - d - 2

  // de Boor
  const pts = []
  for (let j = 0; j <= d; j++) {
    const idx = k - d + j
    if (idx >= 0 && idx <= n) {
      pts.push({ x: controlPoints[idx].x, y: controlPoints[idx].y })
    } else {
      pts.push({ x: 0, y: 0 })
    }
  }

  for (let r = 1; r <= d; r++) {
    for (let j = d; j >= r; j--) {
      const i = k - d + j
      const denom = knots[i + d - r + 1] - knots[i]
      const alpha = denom < 1e-12 ? 0 : (t - knots[i]) / denom
      pts[j] = {
        x: (1 - alpha) * pts[j - 1].x + alpha * pts[j].x,
        y: (1 - alpha) * pts[j - 1].y + alpha * pts[j].y,
      }
    }
  }
  return pts[d]
}

function splineToPoints(entity) {
  const cp = entity.controlPoints
  if (!cp || cp.length < 2) return null

  // Use fit points if available (more accurate)
  if (entity.fitPoints && entity.fitPoints.length >= 2) {
    const pts = entity.fitPoints.map(p => ({ x: p.x, y: p.y }))
    if (entity.closed) pts.push({ ...pts[0] })
    return pts
  }

  const degree = entity.degreeOfSplineCurve || 3
  let knots = entity.knotValues

  // Generate uniform knot vector if missing
  if (!knots || knots.length < cp.length + degree + 1) {
    const n = cp.length - 1
    const m = n + degree + 1
    knots = []
    for (let i = 0; i <= m; i++) {
      if (i <= degree) knots.push(0)
      else if (i >= m - degree) knots.push(1)
      else knots.push((i - degree) / (m - 2 * degree))
    }
  }

  const tMin = knots[degree]
  const tMax = knots[knots.length - degree - 1]
  const pts = []
  const steps = SPLINE_SEGMENTS * Math.max(1, Math.floor(cp.length / 4))

  for (let i = 0; i <= steps; i++) {
    const t = tMin + (tMax - tMin) * (i / steps)
    pts.push(evaluateBSpline(cp, degree, knots, t))
  }

  if (entity.closed && pts.length > 0) pts.push({ ...pts[0] })
  return pts
}

// ── Convert any entity to a segment (array of points with start/end) ─────────

function entityToSegment(entity) {
  if (entity.type === 'LINE') {
    const v = entity.vertices
    if (!v || v.length < 2) return null
    return [{ x: v[0].x, y: v[0].y }, { x: v[1].x, y: v[1].y }]
  }

  if (entity.type === 'ARC') {
    return arcPoints(
      entity.center.x, entity.center.y, entity.radius,
      entity.startAngle, entity.endAngle, false
    )
  }

  if (entity.type === 'SPLINE') {
    return splineToPoints(entity)
  }

  if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
    const verts = entity.vertices || []
    if (verts.length < 2) return null
    const pts = []
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i]
      const next = verts[(i + 1) % verts.length]
      pts.push({ x: v.x, y: v.y })
      if (v.bulge && Math.abs(v.bulge) > 1e-6 && i < verts.length - 1) {
        const b = v.bulge
        const x1 = v.x, y1 = v.y, x2 = next.x, y2 = next.y
        const d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        if (d < 1e-9) continue
        const r = (d * (1 + b * b)) / (4 * Math.abs(b))
        const sign = b > 0 ? 1 : -1
        const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2
        const dx = x2 - x1, dy = y2 - y1
        const cx = midX - sign * (dy / d) * Math.sqrt(Math.max(0, r * r - (d / 2) ** 2))
        const cy = midY + sign * (dx / d) * Math.sqrt(Math.max(0, r * r - (d / 2) ** 2))
        const startA = (Math.atan2(y1 - cy, x1 - cx) * 180) / Math.PI
        const endA = (Math.atan2(y2 - cy, x2 - cx) * 180) / Math.PI
        const arcPts = arcPoints(cx, cy, r, startA, endA, b < 0)
        arcPts.shift() // remove duplicate start
        pts.push(...arcPts)
      }
    }
    if (entity.shape) pts.push({ x: verts[0].x, y: verts[0].y })
    return pts
  }

  if (entity.type === 'CIRCLE') {
    return arcPoints(entity.center.x, entity.center.y, entity.radius, 0, 359.999)
  }

  if (entity.type === 'ELLIPSE') {
    const cx = entity.center.x, cy = entity.center.y
    const mx = entity.majorAxisEndPoint.x, my = entity.majorAxisEndPoint.y
    const majorR = Math.sqrt(mx * mx + my * my)
    const minorR = majorR * entity.axisRatio
    const rot = Math.atan2(my, mx)
    const pts = []
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      const t = (2 * Math.PI * i) / ARC_SEGMENTS
      pts.push({
        x: cx + majorR * Math.cos(t) * Math.cos(rot) - minorR * Math.sin(t) * Math.sin(rot),
        y: cy + majorR * Math.cos(t) * Math.sin(rot) + minorR * Math.sin(t) * Math.cos(rot),
      })
    }
    return pts
  }

  return null
}

// ── Chain segments into closed loops ─────────────────────────────────────────

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function chainSegmentsToLoops(segments, tol = CHAIN_TOL) {
  const segs = segments.map(pts => ({
    pts,
    start: pts[0],
    end: pts[pts.length - 1],
    used: false,
  }))

  const loops = []

  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue

    // Check if this segment is already a closed loop
    if (dist(segs[i].start, segs[i].end) < tol && segs[i].pts.length > 3) {
      segs[i].used = true
      loops.push(segs[i].pts)
      continue
    }

    // Start a new chain from this segment
    const chain = [...segs[i].pts]
    segs[i].used = true

    let extended = true
    while (extended) {
      extended = false
      const tip = chain[chain.length - 1]
      const head = chain[0]

      // Check if chain closed
      if (chain.length > 3 && dist(tip, head) < tol) break

      for (let j = 0; j < segs.length; j++) {
        if (segs[j].used) continue

        if (dist(tip, segs[j].start) < tol) {
          chain.push(...segs[j].pts.slice(1))
          segs[j].used = true
          extended = true
          break
        }
        if (dist(tip, segs[j].end) < tol) {
          chain.push(...segs[j].pts.slice(0, -1).reverse())
          segs[j].used = true
          extended = true
          break
        }
      }
    }

    // Accept if chain is closed and has enough points
    if (chain.length >= 4 && dist(chain[0], chain[chain.length - 1]) < tol * 4) {
      loops.push(chain)
    }
  }

  return loops
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parseDxf(text) {
  const parser = new DxfParser()
  let dxf
  try {
    dxf = parser.parseSync(text)
  } catch (e) {
    throw new Error('Failed to parse DXF: ' + e.message)
  }

  const entities = dxf.entities || []
  const segments = []
  const closedPolygons = []

  for (const entity of entities) {
    // Skip annotation/construction layers
    const layer = (entity.layer || '').toUpperCase()
    if (
      layer.includes('TEXT') || layer.includes('DIMENSION') ||
      layer.includes('CENTER') || layer.includes('HIDDEN') ||
      layer.includes('ANNOTATION') || layer.includes('CONSTRUCTION') ||
      layer.includes('PATTERN') || layer.includes('BREAK') ||
      layer.includes('EXPLODE') || layer.includes('TANGENT') ||
      layer.includes('SECTION_CUTTING') || layer.includes('SKETCH')
    ) continue

    if (entity.type === 'INSERT') continue

    const pts = entityToSegment(entity)
    if (!pts || pts.length < 2) continue

    // Already closed single entities
    if (
      entity.type === 'CIRCLE' ||
      entity.type === 'ELLIPSE' ||
      ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.shape) ||
      (entity.type === 'SPLINE' && entity.closed)
    ) {
      closedPolygons.push(pts)
    } else {
      segments.push(pts)
    }
  }

  // Try to chain open segments into closed loops
  const assembled = chainSegmentsToLoops(segments)
  const all = [...closedPolygons, ...assembled]

  // Normalize: move to positive quadrant, filter tiny shapes
  return all
    .map(normalizePolygon)
    .filter(p => {
      const b = getPolygonBounds(p)
      return p.length >= 4 && b.width > 0.5 && b.height > 0.5
    })
}

export function getPolygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

export function normalizePolygon(poly) {
  const b = getPolygonBounds(poly)
  return poly.map(p => ({ x: p.x - b.minX, y: p.y - b.minY }))
}

export function rotatePolygon(poly, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const rotated = poly.map(p => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }))
  return normalizePolygon(rotated)
}

export function translatePolygon(poly, dx, dy) {
  return poly.map(p => ({ x: p.x + dx, y: p.y + dy }))
}
