// MultiCam G-code generator — EnRoute / A2MC Post format
// Matches: Multicam Australia A2MC Post 11/03/2014

let _lineNum = 10

function n(code) {
  const line = `N${_lineNum} ${code}`
  _lineNum += 10
  return line
}

export function generateGCode(placedParts, toolProfiles, sheetConfig, options = {}) {
  _lineNum = 10
  const units = sheetConfig.units || 'mm'
  const lines = []
  const h = (s) => lines.push(s)

  // Header — matches EnRoute post format
  h(`(EnRoute Software)`)
  h(`(www.enroutesoftware.com)`)
  h(`(Multicam Australia A2MC Post 11/03/2014)`)
  h(`(Plate Size: X${fmt(sheetConfig.width)} Y${fmt(sheetConfig.height)} Z3.0000)`)
  h(`(Parts placed: ${placedParts.filter(p => p.placed).length})`)
  h(n(`G90 G56`))

  // Group placed parts by tool profile
  const byTool = {}
  for (const placed of placedParts) {
    if (!placed.placed) continue
    const profile = toolProfiles.find(t => t.id === placed.toolProfileId) || toolProfiles[0]
    if (!profile) continue
    if (!byTool[profile.id]) byTool[profile.id] = { profile, parts: [] }
    byTool[profile.id].parts.push(placed)
  }

  for (const { profile, parts } of Object.values(byTool)) {
    h(``)
    h(`(--- ${profile.name} ---)`)
    if (profile.bridgesEnabled) {
      h(`(Bridges: ${profile.bridgeCount} x ${profile.bridgeWidth}mm wide, ${profile.bridgeHeight}mm high)`)
    }

    h(n(`M5`))                                               // Spindle off before tool change
    h(n(`M6 T${profile.toolNumber} (${fmt(profile.diameter)} CUTTER)`))  // Tool change
    h(n(`G0 X0.0000 Y0.0000`))                              // Move to safe position
    h(n(`    Z${fmt(profile.safeZ)}`))                       // Raise Z
    h(n(`M3 S${profile.rpm}`))                               // Spindle on

    const passes = Math.ceil(profile.totalDepth / profile.depthPerPass)

    for (const placed of parts) {
      const segs = placed.arcSegments || null  // arc-aware segments if available
      const poly = placed.polygon
      if (!poly || poly.length < 2) continue

      h(``)
      h(`(Part: ${placed.partIndex}  Rotation: ${placed.rotation}deg)`)

      const bridges = profile.bridgesEnabled
        ? computeBridgePositions(poly, profile.bridgeCount, profile.bridgeWidth)
        : []

      for (let pass = 1; pass <= passes; pass++) {
        const cutDepth = Math.min(profile.depthPerPass * pass, profile.totalDepth)
        const cutZ = -cutDepth
        const isFinalPass = pass === passes

        h(`(Pass ${pass}/${passes} Z${fmt(cutZ)})`)

        // Rapid to start XY
        h(n(`G0 X${fmt(poly[0].x)} Y${fmt(poly[0].y)}`))
        // Rapid Z to safe
        h(n(`    Z${fmt(profile.safeZ)}`))
        // Plunge approach to just above material
        h(n(`G1 Z${fmt(profile.plungeZ)} F${profile.plungeRate}`))
        // Plunge to cut depth
        h(n(`G1 Z${fmt(cutZ)} F${profile.plungeRate}`))

        if (bridges.length === 0 || !isFinalPass) {
          emitProfile(poly, profile.feedRate, h)
        } else {
          emitProfileWithBridges(poly, bridges, profile, h)
        }

        // Retract
        h(n(`G0 G40 Z${fmt(profile.safeZ)} F2`))
      }
    }

    h(``)
    h(n(`M5`))
    h(n(`G0 X0.0000 Y0.0000`))
    h(n(`    Z${fmt(profile.safeZ)}`))
  }

  h(``)
  h(n(`M5`))
  h(n(`G0 X0.0000 Y0.0000`))
  h(n(`    Z${fmt(toolProfiles[0]?.safeZ ?? 33)}`))
  h(n(`M30`))

  return lines.join('\n')
}

function emitProfile(poly, feedRate, h) {
  for (let i = 1; i < poly.length; i++) {
    h(n(`G1 X${fmt(poly[i].x)} Y${fmt(poly[i].y)} F${feedRate}`))
  }
  h(n(`G1 X${fmt(poly[0].x)} Y${fmt(poly[0].y)} F${feedRate}`))
}

function emitProfileWithBridges(poly, bridges, profile, h) {
  const feedRate = profile.feedRate
  const bridgeZ = -(profile.totalDepth - profile.bridgeHeight)
  const segmented = segmentWithBridges(poly, bridges, profile.bridgeWidth)

  for (const seg of segmented) {
    if (seg.isBridge) {
      h(n(`G1 Z${fmt(bridgeZ)} F${profile.plungeRate}`))
      h(n(`G1 X${fmt(seg.end.x)} Y${fmt(seg.end.y)} F${feedRate}`))
      h(n(`G1 Z${fmt(-profile.totalDepth)} F${profile.plungeRate}`))
    } else {
      h(n(`G1 X${fmt(seg.end.x)} Y${fmt(seg.end.y)} F${feedRate}`))
    }
  }
}

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
      bridges.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, segIndex: i, t, halfWidth: bridgeWidth / 2 })
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

function segmentWithBridges(poly, bridges, bridgeWidth) {
  const result = []
  const closed = [...poly, poly[0]]
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i], b = closed[i + 1]
    const dx = b.x - a.x, dy = b.y - a.y
    const segLen = Math.sqrt(dx * dx + dy * dy)
    const segBridges = bridges.filter(br => br.segIndex === i).sort((p, q) => p.t - q.t)
    for (const br of segBridges) {
      const hw = br.halfWidth
      const startT = Math.max(0, (br.t * segLen - hw) / segLen)
      const endT = Math.min(1, (br.t * segLen + hw) / segLen)
      if (segLen > 1e-6) {
        result.push({ end: { x: a.x + dx * startT, y: a.y + dy * startT }, isBridge: false })
        result.push({ end: { x: a.x + dx * endT, y: a.y + dy * endT }, isBridge: true })
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
    safeZ: 33,
    plungeZ: 0.3,
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
    safeZ: 33,
    plungeZ: 0.3,
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
    rpm: 24000,
    feedRate: 3000,
    plungeRate: 250,
    depthPerPass: 2,
    totalDepth: 2,
    safeZ: 33,
    plungeZ: 0.3,
    color: '#22c55e',
    bridgesEnabled: false,
    bridgeCount: 2,
    bridgeWidth: 4,
    bridgeHeight: 1,
  },
]
