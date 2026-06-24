// MultiCam G-code generator
// Datum: bottom-left corner (X0 Y0)
// Units: mm (or inches if configured)

export function generateGCode(placedParts, toolProfiles, sheetConfig, options = {}) {
  const { programNumber = 1000 } = options
  const units = sheetConfig.units || 'mm'
  const unitMode = units === 'in' ? 'G20' : 'G21'
  const lines = []
  const h = (s) => lines.push(s)

  h(`%`)
  h(`O${programNumber} (CNC NESTER - MULTICAM)`)
  h(`(Generated: ${new Date().toISOString()})`)
  h(`(Sheet: ${sheetConfig.width} x ${sheetConfig.height} ${units})`)
  h(`(Parts placed: ${placedParts.filter(p => p.placed).length})`)
  h(``)
  h(unitMode)
  h(`G17`)   // XY plane
  h(`G40`)   // Cancel cutter comp
  h(`G49`)   // Cancel tool length offset
  h(`G80`)   // Cancel canned cycles
  h(`G90`)   // Absolute positioning
  h(`G94`)   // Feed per minute
  h(``)

  // Group by tool profile
  const byTool = {}
  for (const placed of placedParts) {
    if (!placed.placed) continue
    const profile = toolProfiles.find(t => t.id === placed.toolProfileId) || toolProfiles[0]
    if (!profile) continue
    if (!byTool[profile.id]) byTool[profile.id] = { profile, parts: [] }
    byTool[profile.id].parts.push({ placed, profile })
  }

  for (const { profile, parts } of Object.values(byTool)) {
    h(``)
    h(`(============================================)`)
    h(`(TOOL ${profile.toolNumber}: ${profile.name})`)
    h(`(Diameter: ${profile.diameter}${units}  RPM: ${profile.rpm})`)
    h(`(Feed: ${profile.feedRate}${units}/min  Plunge: ${profile.plungeRate}${units}/min)`)
    h(`(Depth/pass: ${profile.depthPerPass}${units}  Total depth: ${profile.totalDepth}${units})`)
    if (profile.bridgesEnabled) {
      h(`(Bridges: ${profile.bridgeCount} x ${profile.bridgeWidth}${units} wide, ${profile.bridgeHeight}${units} high)`)
    }
    h(`(============================================)`)
    h(``)
    h(`T${profile.toolNumber} M6`)
    h(`G43 H${profile.toolNumber}`)
    h(`S${profile.rpm} M3`)
    h(`G0 Z${fmt(profile.safeZ)}`)

    const passes = Math.ceil(profile.totalDepth / profile.depthPerPass)

    for (const { placed } of parts) {
      const poly = placed.polygon
      if (!poly || poly.length < 2) continue

      h(``)
      h(`(Part: ${placed.partIndex}  Rotation: ${placed.rotation}deg)`)

      // Compute bridge positions on the polygon perimeter if enabled
      const bridges = profile.bridgesEnabled
        ? computeBridgePositions(poly, profile.bridgeCount, profile.bridgeWidth)
        : []

      for (let pass = 1; pass <= passes; pass++) {
        const cutDepth = Math.min(profile.depthPerPass * pass, profile.totalDepth)
        const cutZ = -cutDepth
        const isFinalPass = pass === passes

        h(`(  Pass ${pass}/${passes}  Z=${fmt(cutZ)})`)

        // Rapid to start point
        h(`G0 X${fmt(poly[0].x)} Y${fmt(poly[0].y)}`)
        h(`G0 Z${fmt(profile.plungeZ)}`)
        h(`G1 Z${fmt(cutZ)} F${profile.plungeRate}`)

        if (bridges.length === 0 || !isFinalPass) {
          // Full depth cut with no bridges
          cutProfile(poly, profile.feedRate, h)
        } else {
          // Final pass: lift over bridge segments
          cutProfileWithBridges(poly, bridges, profile, h)
        }

        h(`G0 Z${fmt(profile.safeZ)}`)
      }
    }

    h(``)
    h(`M5   (Spindle off - T${profile.toolNumber} done)`)
  }

  h(``)
  h(`G0 Z${fmt(toolProfiles[0]?.safeZ ?? 25)}`)
  h(`G0 X0.0000 Y0.0000   (Return to datum)`)
  h(`M30`)
  h(`%`)

  return lines.join('\n')
}

function cutProfile(poly, feedRate, h) {
  for (let i = 1; i < poly.length; i++) {
    h(`G1 X${fmt(poly[i].x)} Y${fmt(poly[i].y)} F${feedRate}`)
  }
  h(`G1 X${fmt(poly[0].x)} Y${fmt(poly[0].y)} F${feedRate}`)
}

function cutProfileWithBridges(poly, bridges, profile, h) {
  // Build a flat list of segments with bridge flags
  const feedRate = profile.feedRate
  const bridgeZ = -(profile.totalDepth - profile.bridgeHeight)

  const segmented = segmentWithBridges(poly, bridges, profile.bridgeWidth)

  for (const seg of segmented) {
    if (seg.isBridge) {
      // Lift to bridge height, traverse, plunge back
      h(`G1 Z${fmt(bridgeZ)} F${profile.plungeRate}   (bridge lift)`)
      h(`G1 X${fmt(seg.end.x)} Y${fmt(seg.end.y)} F${feedRate}`)
      h(`G1 Z${fmt(-profile.totalDepth)} F${profile.plungeRate}   (bridge plunge)`)
    } else {
      h(`G1 X${fmt(seg.end.x)} Y${fmt(seg.end.y)} F${feedRate}`)
    }
  }
}

// Distribute bridge positions evenly around the polygon perimeter
export function computeBridgePositions(poly, count, bridgeWidth) {
  const perimeter = polygonPerimeter(poly)
  const spacing = perimeter / count
  const bridges = []

  let dist = spacing / 2
  let accumulated = 0

  for (let i = 0; i < poly.length && bridges.length < count; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)

    while (dist <= accumulated + segLen && bridges.length < count) {
      const t = (dist - accumulated) / segLen
      bridges.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        segIndex: i,
        t,
        halfWidth: bridgeWidth / 2,
      })
      dist += spacing
    }
    accumulated += segLen
  }

  return bridges
}

function polygonPerimeter(poly) {
  let len = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    len += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
  }
  return len
}

// Convert polygon + bridge positions into a list of segments tagged isBridge
function segmentWithBridges(poly, bridges, bridgeWidth) {
  // Build ordered points along the poly with bridge markers
  const result = []
  const closed = [...poly, poly[0]]

  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i]
    const b = closed[i + 1]
    const dx = b.x - a.x, dy = b.y - a.y
    const segLen = Math.sqrt(dx * dx + dy * dy)
    const ux = dx / segLen, uy = dy / segLen

    // Find any bridges on this segment, sorted by t
    const segBridges = bridges
      .filter(br => br.segIndex === i)
      .sort((p, q) => p.t - q.t)

    let prevPt = a
    for (const br of segBridges) {
      const hw = br.halfWidth
      const startT = Math.max(0, (br.t * segLen - hw) / segLen)
      const endT = Math.min(1, (br.t * segLen + hw) / segLen)
      const bStart = { x: a.x + dx * startT, y: a.y + dy * startT }
      const bEnd = { x: a.x + dx * endT, y: a.y + dy * endT }

      if (segLen > 1e-6) {
        result.push({ end: bStart, isBridge: false })
        result.push({ end: bEnd, isBridge: true })
        prevPt = bEnd
      }
    }
    result.push({ end: b, isBridge: false })
  }

  return result
}

function fmt(n) {
  return (typeof n === 'number' ? n : 0).toFixed(4)
}

export const DEFAULT_TOOL_PROFILES = [
  {
    id: 'profile-1',
    name: 'Compression Bit - Outer Profile',
    toolNumber: 1,
    diameter: 6.35,
    rpm: 18000,
    feedRate: 5000,
    plungeRate: 1500,
    depthPerPass: 12,
    totalDepth: 18,
    safeZ: 25,
    plungeZ: 2,
    color: '#ef4444',
    bridgesEnabled: true,
    bridgeCount: 4,
    bridgeWidth: 6,
    bridgeHeight: 3,
  },
  {
    id: 'profile-2',
    name: 'Upcut Spiral - Pocket',
    toolNumber: 2,
    diameter: 6.35,
    rpm: 16000,
    feedRate: 4000,
    plungeRate: 1200,
    depthPerPass: 8,
    totalDepth: 12,
    safeZ: 25,
    plungeZ: 2,
    color: '#3b82f6',
    bridgesEnabled: false,
    bridgeCount: 4,
    bridgeWidth: 6,
    bridgeHeight: 3,
  },
  {
    id: 'profile-3',
    name: 'V-Bit - Score / Engrave',
    toolNumber: 3,
    diameter: 3.175,
    rpm: 22000,
    feedRate: 3000,
    plungeRate: 800,
    depthPerPass: 2,
    totalDepth: 2,
    safeZ: 25,
    plungeZ: 2,
    color: '#22c55e',
    bridgesEnabled: false,
    bridgeCount: 2,
    bridgeWidth: 4,
    bridgeHeight: 1,
  },
]
