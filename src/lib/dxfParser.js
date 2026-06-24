import DxfParser from 'dxf-parser'

const ARC_SEGMENTS = 32

function arcToPolyline(cx, cy, radius, startAngle, endAngle, ccw = false) {
  const pts = []
  let start = (startAngle * Math.PI) / 180
  let end = (endAngle * Math.PI) / 180
  if (!ccw && end <= start) end += Math.PI * 2
  if (ccw && end >= start) end -= Math.PI * 2
  const steps = Math.max(4, Math.round(Math.abs(end - start) * (ARC_SEGMENTS / (Math.PI * 2))))
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps
    pts.push({ x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) })
  }
  return pts
}

function circleToPolyline(cx, cy, radius) {
  return arcToPolyline(cx, cy, radius, 0, 360)
}

function entityToPolygons(entity) {
  const polys = []

  if (entity.type === 'LINE') {
    // Lines on their own aren't closed profiles; collect for later assembly
    return null // handled separately
  }

  if (entity.type === 'CIRCLE') {
    polys.push(circleToPolyline(entity.center.x, entity.center.y, entity.radius))
    return polys
  }

  if (entity.type === 'ARC') {
    // Open arc — not a closed profile by itself
    return null
  }

  if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
    const verts = entity.vertices || []
    if (verts.length < 2) return null
    const pts = verts.map(v => ({ x: v.x, y: v.y }))
    // Handle bulge (arc segments in LWPOLYLINE)
    if (entity.type === 'LWPOLYLINE') {
      const expanded = []
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i]
        const next = verts[(i + 1) % verts.length]
        expanded.push({ x: v.x, y: v.y })
        if (v.bulge && Math.abs(v.bulge) > 1e-6) {
          const b = v.bulge
          const x1 = v.x, y1 = v.y, x2 = next.x, y2 = next.y
          const d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
          const r = (d * (1 + b * b)) / (4 * Math.abs(b))
          const a = 4 * Math.atan(Math.abs(b))
          const midX = (x1 + x2) / 2
          const midY = (y1 + y2) / 2
          const dx = x2 - x1, dy = y2 - y1
          const sign = b > 0 ? 1 : -1
          const cx = midX - sign * (dy / d) * Math.sqrt(r * r - (d / 2) ** 2)
          const cy = midY + sign * (dx / d) * Math.sqrt(r * r - (d / 2) ** 2)
          const startA = (Math.atan2(y1 - cy, x1 - cx) * 180) / Math.PI
          const endA = (Math.atan2(y2 - cy, x2 - cx) * 180) / Math.PI
          const arcPts = arcToPolyline(cx, cy, r, startA, endA, b < 0)
          arcPts.shift()
          expanded.push(...arcPts)
        }
      }
      if (entity.shape) {
        expanded.push({ x: verts[0].x, y: verts[0].y })
      }
      polys.push(expanded)
      return polys
    }
    if (entity.shape) pts.push({ x: verts[0].x, y: verts[0].y })
    polys.push(pts)
    return polys
  }

  if (entity.type === 'SPLINE') {
    if (!entity.controlPoints || entity.controlPoints.length < 2) return null
    // Approximate spline with control points
    const pts = entity.controlPoints.map(p => ({ x: p.x, y: p.y }))
    if (entity.closed) pts.push({ x: pts[0].x, y: pts[0].y })
    polys.push(pts)
    return polys
  }

  if (entity.type === 'ELLIPSE') {
    const cx = entity.center.x, cy = entity.center.y
    const majorX = entity.majorAxisEndPoint.x, majorY = entity.majorAxisEndPoint.y
    const majorR = Math.sqrt(majorX ** 2 + majorY ** 2)
    const minorR = majorR * entity.axisRatio
    const rotation = Math.atan2(majorY, majorX)
    const pts = []
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      const t = (2 * Math.PI * i) / ARC_SEGMENTS
      const ex = majorR * Math.cos(t)
      const ey = minorR * Math.sin(t)
      pts.push({
        x: cx + ex * Math.cos(rotation) - ey * Math.sin(rotation),
        y: cy + ex * Math.sin(rotation) + ey * Math.cos(rotation),
      })
    }
    polys.push(pts)
    return polys
  }

  return null
}

function tryAssembleClosedLoops(lines, tolerance = 0.01) {
  if (lines.length === 0) return []
  const segments = lines.map(e => ({
    start: { x: e.vertices[0].x, y: e.vertices[0].y },
    end: { x: e.vertices[1].x, y: e.vertices[1].y },
    used: false,
  }))

  const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
  const loops = []

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].used) continue
    const loop = [segments[i].start, segments[i].end]
    segments[i].used = true

    let extended = true
    while (extended) {
      extended = false
      const tip = loop[loop.length - 1]
      for (let j = 0; j < segments.length; j++) {
        if (segments[j].used) continue
        if (dist(tip, segments[j].start) < tolerance) {
          loop.push(segments[j].end)
          segments[j].used = true
          extended = true
          break
        }
        if (dist(tip, segments[j].end) < tolerance) {
          loop.push(segments[j].start)
          segments[j].used = true
          extended = true
          break
        }
      }
    }

    if (dist(loop[0], loop[loop.length - 1]) < tolerance * 2 && loop.length > 3) {
      loops.push(loop)
    }
  }
  return loops
}

export function parseDxf(text) {
  const parser = new DxfParser()
  let dxf
  try {
    dxf = parser.parseSync(text)
  } catch (e) {
    throw new Error('Failed to parse DXF: ' + e.message)
  }

  const entities = dxf.entities || []
  const polygons = []
  const lineEntities = []

  for (const entity of entities) {
    if (entity.type === 'LINE') {
      lineEntities.push(entity)
    } else if (entity.type === 'INSERT') {
      // Skip block inserts for now
    } else {
      const result = entityToPolygons(entity)
      if (result) polygons.push(...result)
    }
  }

  const lineLoops = tryAssembleClosedLoops(lineEntities)
  polygons.push(...lineLoops)

  // Filter to only reasonably sized closed polygons (>= 3 points)
  return polygons.filter(p => p.length >= 3)
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
