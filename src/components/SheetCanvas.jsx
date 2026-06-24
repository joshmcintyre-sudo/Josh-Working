import { Stage, Layer, Rect, Line, Text, Group, Circle } from 'react-konva'
import { useMemo, useRef, useState, useCallback } from 'react'

const CANVAS_W = 900
const CANVAS_H = 620
const PADDING = 48
const MIN_SCALE = 0.1
const MAX_SCALE = 20

export default function SheetCanvas({ sheetConfig, nestedParts, toolProfiles, onPartMove }) {
  const stageRef = useRef()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  const baseScale = useMemo(() => {
    const sx = (CANVAS_W - PADDING * 2) / sheetConfig.width
    const sy = (CANVAS_H - PADDING * 2) / sheetConfig.height
    return Math.min(sx, sy)
  }, [sheetConfig])

  const scale = baseScale * zoom

  const toCanvas = useCallback((x, y) => ({
    x: PADDING + pan.x + x * scale,
    y: PADDING + pan.y + (sheetConfig.height - y) * scale,
  }), [scale, pan, sheetConfig.height])

  const polyToFlat = useCallback((poly) => {
    const pts = []
    for (const p of poly) {
      const c = toCanvas(p.x, p.y)
      pts.push(c.x, c.y)
    }
    if (poly.length > 0) {
      const c = toCanvas(poly[0].x, poly[0].y)
      pts.push(c.x, c.y)
    }
    return pts
  }, [toCanvas])

  const profileById = (id) => toolProfiles.find(t => t.id === id)

  const sheetOrigin = toCanvas(0, 0)
  const sheetW = sheetConfig.width * scale
  const sheetH = sheetConfig.height * scale

  // Mouse wheel zoom centred on cursor
  const handleWheel = (e) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    const pointer = stage.getPointerPosition()
    const factor = e.evt.deltaY < 0 ? 1.15 : 1 / 1.15
    const newZoom = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom * factor))

    // Adjust pan so zoom centres on cursor
    const mouseX = pointer.x - PADDING
    const mouseY = pointer.y - PADDING
    const newPanX = mouseX - (mouseX - pan.x) * (newZoom / zoom)
    const newPanY = mouseY - (mouseY - pan.y) * (newZoom / zoom)

    setZoom(newZoom)
    setPan({ x: newPanX, y: newPanY })
  }

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  const gridStep = zoom < 0.3 ? 500 : zoom < 0.8 ? 200 : 100

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="btn-sm" onClick={() => setZoom(z => Math.min(MAX_SCALE, z * 1.3))}>+</button>
        <button className="btn-sm" onClick={() => setZoom(z => Math.max(MIN_SCALE, z / 1.3))}>−</button>
        <button className="btn-sm" onClick={resetView}>Fit</button>
        <span className="canvas-hint">Scroll to zoom · Drag sheet to pan</span>
      </div>

      <Stage
        width={CANVAS_W}
        height={CANVAS_H}
        ref={stageRef}
        style={{ background: '#0f0f1a', cursor: 'grab' }}
        onWheel={handleWheel}
        draggable
        onDragEnd={(e) => {
          setPan(prev => ({
            x: prev.x + e.target.x(),
            y: prev.y + e.target.y(),
          }))
          e.target.position({ x: 0, y: 0 })
        }}
      >
        <Layer>
          {/* Sheet */}
          <Rect
            x={sheetOrigin.x}
            y={sheetOrigin.y - sheetH}
            width={sheetW}
            height={sheetH}
            fill="#1e1e35"
            stroke="#4a4a6e"
            strokeWidth={1}
          />

          {/* Grid */}
          {Array.from({ length: Math.floor(sheetConfig.width / gridStep) }).map((_, i) => {
            const cx = sheetOrigin.x + (i + 1) * gridStep * scale
            return (
              <Line key={`gx-${i}`}
                points={[cx, sheetOrigin.y - sheetH, cx, sheetOrigin.y]}
                stroke="#2a2a50" strokeWidth={0.5} />
            )
          })}
          {Array.from({ length: Math.floor(sheetConfig.height / gridStep) }).map((_, i) => {
            const cy = sheetOrigin.y - (i + 1) * gridStep * scale
            return (
              <Line key={`gy-${i}`}
                points={[sheetOrigin.x, cy, sheetOrigin.x + sheetW, cy]}
                stroke="#2a2a50" strokeWidth={0.5} />
            )
          })}

          {/* Margin boundary */}
          {sheetConfig.margin > 0 && (
            <Rect
              x={sheetOrigin.x + sheetConfig.margin * scale}
              y={sheetOrigin.y - sheetH + sheetConfig.margin * scale}
              width={sheetW - sheetConfig.margin * 2 * scale}
              height={sheetH - sheetConfig.margin * 2 * scale}
              fill="transparent"
              stroke="#3a3a60"
              strokeWidth={1}
              dash={[4, 4]}
            />
          )}

          {/* Datum label */}
          <Text x={sheetOrigin.x + 4} y={sheetOrigin.y - 16} text="X0 Y0" fontSize={11} fill="#555" />

          {/* Parts */}
          {nestedParts.map((placed, i) => {
            if (!placed.placed) return null
            const profile = profileById(placed.toolProfileId) || toolProfiles[0]
            const color = profile?.color || '#ffffff'
            const pts = polyToFlat(placed.polygon)
            return (
              <Group key={i}>
                <Line
                  points={pts}
                  fill={color + '28'}
                  stroke={color}
                  strokeWidth={Math.max(1, 1.5 / zoom)}
                  closed
                />
                {/* Bridge markers */}
                {placed.bridges && placed.bridges.map((b, bi) => {
                  const bc = toCanvas(b.x, b.y)
                  return (
                    <Rect key={bi}
                      x={bc.x - 4} y={bc.y - 4}
                      width={8} height={8}
                      fill="#fbbf24" stroke="#f59e0b" strokeWidth={1}
                    />
                  )
                })}
              </Group>
            )
          })}

          {/* Unplaced warning */}
          {nestedParts.some(p => !p.placed) && (
            <Text
              x={PADDING} y={12}
              text={`⚠  ${nestedParts.filter(p => !p.placed).length} part(s) could not fit — reduce gap or increase sheet size`}
              fontSize={12} fill="#fbbf24"
            />
          )}

          {/* Sheet size label */}
          <Text
            x={sheetOrigin.x + sheetW / 2 - 30}
            y={sheetOrigin.y + 6}
            text={`${sheetConfig.width} × ${sheetConfig.height} mm`}
            fontSize={11} fill="#444"
          />
        </Layer>
      </Stage>
    </div>
  )
}
