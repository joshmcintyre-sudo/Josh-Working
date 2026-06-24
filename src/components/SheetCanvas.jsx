import { Stage, Layer, Rect, Line, Text, Group } from 'react-konva'
import { useMemo, useRef } from 'react'

const CANVAS_W = 900
const CANVAS_H = 600
const PADDING = 40

export default function SheetCanvas({ sheetConfig, nestedParts, toolProfiles, onPartMove }) {
  const stageRef = useRef()

  const scale = useMemo(() => {
    const sx = (CANVAS_W - PADDING * 2) / sheetConfig.width
    const sy = (CANVAS_H - PADDING * 2) / sheetConfig.height
    return Math.min(sx, sy)
  }, [sheetConfig])

  const toCanvas = (x, y) => ({
    x: PADDING + x * scale,
    y: PADDING + (sheetConfig.height - y) * scale, // flip Y for screen coords
  })

  const polyToFlat = (poly) => {
    const pts = []
    for (const p of poly) {
      const c = toCanvas(p.x, p.y)
      pts.push(c.x, c.y)
    }
    // close
    if (poly.length > 0) {
      const c = toCanvas(poly[0].x, poly[0].y)
      pts.push(c.x, c.y)
    }
    return pts
  }

  const profileById = (id) => toolProfiles.find(t => t.id === id)

  const sheetOrigin = toCanvas(0, 0)
  const sheetCorner = toCanvas(sheetConfig.width, sheetConfig.height)
  const sheetW = sheetCorner.x - sheetOrigin.x
  const sheetH = sheetOrigin.y - sheetCorner.y

  return (
    <div className="canvas-container">
      <Stage width={CANVAS_W} height={CANVAS_H} ref={stageRef} style={{ background: '#1a1a2e' }}>
        <Layer>
          {/* Sheet boundary */}
          <Rect
            x={PADDING}
            y={PADDING}
            width={Math.abs(sheetW)}
            height={Math.abs(sheetH)}
            fill="#2a2a3e"
            stroke="#4a4a6e"
            strokeWidth={1}
          />

          {/* Grid lines every 100mm */}
          {Array.from({ length: Math.floor(sheetConfig.width / 100) }).map((_, i) => {
            const cx = PADDING + (i + 1) * 100 * scale
            return (
              <Line
                key={`gx-${i}`}
                points={[cx, PADDING, cx, PADDING + Math.abs(sheetH)]}
                stroke="#333355"
                strokeWidth={0.5}
              />
            )
          })}
          {Array.from({ length: Math.floor(sheetConfig.height / 100) }).map((_, i) => {
            const cy = PADDING + (i + 1) * 100 * scale
            return (
              <Line
                key={`gy-${i}`}
                points={[PADDING, cy, PADDING + Math.abs(sheetW), cy]}
                stroke="#333355"
                strokeWidth={0.5}
              />
            )
          })}

          {/* Datum label */}
          <Text
            x={PADDING + 4}
            y={PADDING + Math.abs(sheetH) - 18}
            text="X0 Y0"
            fontSize={11}
            fill="#888"
          />

          {/* Nested parts */}
          {nestedParts.map((placed, i) => {
            if (!placed.placed) return null
            const profile = profileById(placed.toolProfileId) || toolProfiles[0]
            const color = profile?.color || '#ffffff'
            const pts = polyToFlat(placed.polygon)
            return (
              <Group key={i}>
                <Line
                  points={pts}
                  fill={color + '33'}
                  stroke={color}
                  strokeWidth={1.5}
                  closed
                  draggable
                  onDragEnd={(e) => {
                    const dx = e.target.x() / scale
                    const dy = -e.target.y() / scale
                    onPartMove && onPartMove(i, dx, dy)
                    e.target.position({ x: 0, y: 0 })
                  }}
                />
                {/* Bridge markers */}
                {placed.bridges && placed.bridges.map((b, bi) => {
                  const bc = toCanvas(b.x, b.y)
                  return (
                    <Rect
                      key={bi}
                      x={bc.x - 4}
                      y={bc.y - 4}
                      width={8}
                      height={8}
                      fill="#fbbf24"
                      stroke="#f59e0b"
                      strokeWidth={1}
                    />
                  )
                })}
              </Group>
            )
          })}

          {/* Unplaced indicator */}
          {nestedParts.some(p => !p.placed) && (
            <Text
              x={PADDING}
              y={PADDING - 20}
              text={`⚠ ${nestedParts.filter(p => !p.placed).length} part(s) could not be placed — sheet too small or increase gap`}
              fontSize={12}
              fill="#fbbf24"
            />
          )}

          {/* Sheet dimensions */}
          <Text
            x={PADDING + Math.abs(sheetW) / 2 - 40}
            y={PADDING + Math.abs(sheetH) + 8}
            text={`${sheetConfig.width} mm`}
            fontSize={11}
            fill="#666"
          />
          <Text
            x={PADDING - 38}
            y={PADDING + Math.abs(sheetH) / 2 - 20}
            text={`${sheetConfig.height}`}
            fontSize={11}
            fill="#666"
            rotation={-90}
          />
        </Layer>
      </Stage>
    </div>
  )
}
