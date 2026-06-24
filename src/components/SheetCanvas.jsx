import { Stage, Layer, Rect, Line, Circle, Group, Text, Arrow } from 'react-konva'
import { useRef, useState, useCallback, useEffect } from 'react'
import { rotatePolygon, getPolygonBounds } from '../lib/dxfParser.js'

const CANVAS_W = 900
const CANVAS_H = 640

export default function SheetCanvas({ sheetConfig, nestedParts, toolProfiles, onPartMove, onPartRotate }) {
  const stageRef = useRef()
  const [zoom, setZoom] = useState(1)          // just for label display
  const [selectedIdx, setSelectedIdx] = useState(null)

  // Simulation
  const [simState, setSimState] = useState('idle') // idle | playing | paused
  const [simStep, setSimStep] = useState(0)
  const [simSpeed, setSimSpeed] = useState(5)
  const simRef = useRef({ running: false, step: 0, timer: null })
  const waypointsRef = useRef([])

  // ── Base scale: fit sheet into canvas ──────────────────────────────────────
  const baseScale = Math.min(
    (CANVAS_W - 80) / sheetConfig.width,
    (CANVAS_H - 80) / sheetConfig.height,
  )

  // ── Fit view to placed parts ───────────────────────────────────────────────
  const fitParts = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const placed = nestedParts.filter(p => p.placed && p.polygon)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const source = placed.length ? placed : [{ polygon: [
      { x: 0, y: 0 }, { x: sheetConfig.width, y: 0 },
      { x: sheetConfig.width, y: sheetConfig.height }, { x: 0, y: sheetConfig.height },
    ]}]
    for (const p of source) for (const pt of p.polygon) {
      if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y
      if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y
    }
    const pw = maxX - minX || 1, ph = maxY - minY || 1
    const s = Math.min((CANVAS_W - 80) / pw, (CANVAS_H - 80) / ph) * 0.9
    // account for Y-flip group: world Y=0 is at screen y = 40 + sheetConfig.height*s
    const cx = 40 + (minX + pw / 2) * s
    const cy = 40 + (sheetConfig.height - (minY + ph / 2)) * s
    stage.scale({ x: s, y: s })
    stage.position({ x: CANVAS_W / 2 - cx * (s / s), y: CANVAS_H / 2 - cy * (s / s) })
    // simpler: translate so bounding centre hits canvas centre
    stage.position({
      x: CANVAS_W / 2 - (40 + (minX + pw / 2) * s),
      y: CANVAS_H / 2 - (40 + (sheetConfig.height - (minY + ph / 2)) * s),
    })
    setZoom(s)
    stage.batchDraw()
  }, [nestedParts, sheetConfig])

  const fitSheet = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.scale({ x: baseScale, y: baseScale })
    stage.position({ x: 0, y: 0 })
    setZoom(baseScale)
    stage.batchDraw()
  }, [baseScale])

  // ── Wheel zoom centred on cursor ───────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    const oldScale = stage.scaleX()
    const pointer = stage.getPointerPosition()
    const factor = e.evt.deltaY < 0 ? 1.12 : 1 / 1.12
    const newScale = Math.min(200, Math.max(0.005, oldScale * factor))
    const mx = (pointer.x - stage.x()) / oldScale
    const my = (pointer.y - stage.y()) / oldScale
    stage.scale({ x: newScale, y: newScale })
    stage.position({ x: pointer.x - mx * newScale, y: pointer.y - my * newScale })
    setZoom(newScale)
    stage.batchDraw()
  }, [])

  // ── Simulation waypoints ───────────────────────────────────────────────────
  const buildWaypoints = useCallback(() => {
    const wpts = [{ x: 0, y: 0, type: 'rapid' }]
    const profileById = id => toolProfiles.find(t => t.id === id) || toolProfiles[0]

    // Group by tool
    const byTool = {}
    for (const placed of nestedParts) {
      if (!placed.placed) continue
      const pid = placed.toolProfileId
      if (!byTool[pid]) byTool[pid] = []
      byTool[pid].push(placed)
    }

    for (const [pid, parts] of Object.entries(byTool)) {
      const profile = profileById(pid)
      const passes = Math.ceil(profile.totalDepth / profile.depthPerPass)
      for (const placed of parts) {
        const poly = placed.polygon
        if (!poly || poly.length < 2) continue
        for (let pass = 0; pass < passes; pass++) {
          wpts.push({ x: poly[0].x, y: poly[0].y, type: 'rapid', toolColor: profile.color })
          for (let i = 1; i < poly.length; i++) {
            wpts.push({ x: poly[i].x, y: poly[i].y, type: 'cut', toolColor: profile.color })
          }
          wpts.push({ x: poly[0].x, y: poly[0].y, type: 'cut', toolColor: profile.color })
          wpts.push({ x: poly[0].x, y: poly[0].y, type: 'rapid', toolColor: profile.color })
        }
      }
    }
    wpts.push({ x: 0, y: 0, type: 'rapid' })
    return wpts
  }, [nestedParts, toolProfiles])

  const startSim = () => {
    const wpts = buildWaypoints()
    waypointsRef.current = wpts
    simRef.current.step = 0
    simRef.current.running = true
    setSimStep(0)
    setSimState('playing')
  }

  const pauseSim = () => {
    simRef.current.running = false
    setSimState('paused')
  }

  const resumeSim = () => {
    simRef.current.running = true
    setSimState('playing')
  }

  const stopSim = () => {
    simRef.current.running = false
    simRef.current.step = 0
    setSimStep(0)
    setSimState('idle')
  }

  useEffect(() => {
    if (simState !== 'playing') return
    const interval = setInterval(() => {
      if (!simRef.current.running) return
      simRef.current.step += simSpeed
      const max = waypointsRef.current.length - 1
      if (simRef.current.step >= max) {
        simRef.current.step = max
        simRef.current.running = false
        setSimState('idle')
      }
      setSimStep(simRef.current.step)
    }, 16)
    return () => clearInterval(interval)
  }, [simState, simSpeed])

  // ── Helpers ────────────────────────────────────────────────────────────────
  const profileById = id => toolProfiles.find(t => t.id === id) || toolProfiles[0]

  const polyFlat = poly => poly.flatMap(p => [p.x, p.y])

  const gridStep = (stageRef.current ? stageRef.current.scaleX() : baseScale) < 0.05 ? 500
    : (stageRef.current ? stageRef.current.scaleX() : baseScale) < 0.15 ? 200 : 100

  // ── Simulation geometry ───────────────────────────────────────────────────
  const wpts = waypointsRef.current
  const curStep = Math.min(simStep, wpts.length - 1)
  const toolPos = wpts[curStep] || { x: 0, y: 0 }
  const cutPts = []
  const rapidPts = []
  for (let i = 0; i < curStep; i++) {
    const a = wpts[i], b = wpts[i + 1]
    if (b.type === 'cut') cutPts.push(a.x, a.y, b.x, b.y)
    else rapidPts.push(a.x, a.y, b.x, b.y)
  }

  const zoomPct = Math.round(zoom * 100)
  const sw = 1 / zoom   // stroke width in world units — thins as you zoom in

  return (
    <div className="canvas-wrap">
      {/* Toolbar */}
      <div className="canvas-toolbar">
        <span className="zoom-label">{zoomPct}%</span>
        <button className="btn-sm" onClick={() => {
          const s = stageRef.current; if (!s) return
          const ns = Math.min(200, s.scaleX() * 1.25)
          const cx = CANVAS_W/2, cy = CANVAS_H/2
          const mx = (cx - s.x()) / s.scaleX()
          const my = (cy - s.y()) / s.scaleX()
          s.scale({ x: ns, y: ns }); s.position({ x: cx - mx*ns, y: cy - my*ns })
          setZoom(ns)
        }}>+</button>
        <button className="btn-sm" onClick={() => {
          const s = stageRef.current; if (!s) return
          const ns = Math.max(0.005, s.scaleX() / 1.25)
          const cx = CANVAS_W/2, cy = CANVAS_H/2
          const mx = (cx - s.x()) / s.scaleX()
          const my = (cy - s.y()) / s.scaleX()
          s.scale({ x: ns, y: ns }); s.position({ x: cx - mx*ns, y: cy - my*ns })
          setZoom(ns)
        }}>−</button>
        <button className="btn-sm" onClick={fitParts}>Fit</button>
        <button className="btn-sm" onClick={fitSheet}>Sheet</button>

        {/* Part controls when selected */}
        {selectedIdx !== null && (
          <>
            <span className="toolbar-sep" />
            <span className="zoom-label" style={{ color: '#a5b4fc' }}>Part selected</span>
            <button className="btn-sm" onClick={() => onPartRotate && onPartRotate(selectedIdx, -90)}>↺ 90°</button>
            <button className="btn-sm" onClick={() => onPartRotate && onPartRotate(selectedIdx, 90)}>↻ 90°</button>
            <button className="btn-sm" onClick={() => setSelectedIdx(null)}>Deselect</button>
          </>
        )}

        {/* Simulation controls */}
        {nestedParts.some(p => p.placed) && (
          <>
            <span className="toolbar-sep" />
            {simState === 'idle' && (
              <button className="btn-sm btn-sim" onClick={startSim}>▶ Simulate</button>
            )}
            {simState === 'playing' && (
              <button className="btn-sm btn-sim" onClick={pauseSim}>⏸ Pause</button>
            )}
            {simState === 'paused' && (
              <button className="btn-sm btn-sim" onClick={resumeSim}>▶ Resume</button>
            )}
            {simState !== 'idle' && (
              <button className="btn-sm" onClick={stopSim}>⏹</button>
            )}
            <label className="zoom-label">Speed</label>
            <input
              type="range" min={1} max={50} value={simSpeed}
              onChange={e => setSimSpeed(Number(e.target.value))}
              style={{ width: 70 }}
            />
          </>
        )}

        <span className="canvas-hint">Scroll zoom · Drag pan · Click part to select</span>
      </div>

      <Stage
        ref={stageRef}
        width={CANVAS_W}
        height={CANVAS_H}
        scaleX={baseScale}
        scaleY={baseScale}
        style={{ background: '#0f0f1a', cursor: 'grab' }}
        draggable
        onWheel={handleWheel}
        onDragEnd={() => {
          // sync zoom label only — DO NOT reset stage position
          setZoom(stageRef.current?.scaleX() ?? baseScale)
        }}
        onClick={e => {
          if (e.target === e.target.getStage()) setSelectedIdx(null)
        }}
      >
        <Layer>
          {/* Y-flip group: world Y=0 at bottom-left */}
          <Group y={sheetConfig.height} scaleY={-1}>

            {/* Sheet */}
            <Rect x={0} y={0} width={sheetConfig.width} height={sheetConfig.height}
              fill="#1e1e35" stroke="#4a4a6e" strokeWidth={sw} />

            {/* Grid */}
            {Array.from({ length: Math.floor(sheetConfig.width / gridStep) }).map((_, i) => (
              <Line key={`gx${i}`}
                points={[(i+1)*gridStep, 0, (i+1)*gridStep, sheetConfig.height]}
                stroke="#252540" strokeWidth={sw * 0.5} />
            ))}
            {Array.from({ length: Math.floor(sheetConfig.height / gridStep) }).map((_, i) => (
              <Line key={`gy${i}`}
                points={[0, (i+1)*gridStep, sheetConfig.width, (i+1)*gridStep]}
                stroke="#252540" strokeWidth={sw * 0.5} />
            ))}

            {/* Margin */}
            {sheetConfig.margin > 0 && (
              <Rect x={sheetConfig.margin} y={sheetConfig.margin}
                width={sheetConfig.width - sheetConfig.margin*2}
                height={sheetConfig.height - sheetConfig.margin*2}
                fill="transparent" stroke="#333360" strokeWidth={sw * 0.5} dash={[4*sw, 4*sw]} />
            )}

            {/* Placed parts */}
            {nestedParts.map((placed, i) => {
              if (!placed.placed) return null
              const profile = profileById(placed.toolProfileId)
              const color = profile?.color || '#ffffff'
              const isSelected = selectedIdx === i
              const pts = polyFlat(placed.polygon)

              return (
                <Group key={i}>
                  <Line
                    points={pts}
                    fill={isSelected ? color + '55' : color + '22'}
                    stroke={isSelected ? '#ffffff' : color}
                    strokeWidth={isSelected ? sw * 2 : sw * 1.5}
                    closed
                    draggable
                    onClick={(e) => { e.cancelBubble = true; setSelectedIdx(i) }}
                    onDragEnd={(e) => {
                      onPartMove && onPartMove(i, e.target.x(), e.target.y())
                      e.target.position({ x: 0, y: 0 })
                    }}
                  />
                  {/* Bridge markers */}
                  {placed.bridges?.map((b, bi) => (
                    <Rect key={bi}
                      x={b.x - 3*sw} y={b.y - 3*sw}
                      width={6*sw} height={6*sw}
                      fill="#fbbf24" stroke="#f59e0b" strokeWidth={sw * 0.5} />
                  ))}
                </Group>
              )
            })}

            {/* Simulation: rapid moves */}
            {simState !== 'idle' && rapidPts.length >= 4 && (
              <Line points={rapidPts} stroke="#4444aa" strokeWidth={sw * 0.8} />
            )}
            {/* Simulation: cut moves */}
            {simState !== 'idle' && cutPts.length >= 4 && (
              <Line points={cutPts} stroke="#00ffcc" strokeWidth={sw * 1.2} opacity={0.8} />
            )}
            {/* Simulation: tool head */}
            {simState !== 'idle' && (
              <Group>
                <Circle x={toolPos.x} y={toolPos.y}
                  radius={4*sw} fill="#ffffff" opacity={0.9} />
                <Circle x={toolPos.x} y={toolPos.y}
                  radius={8*sw} stroke="#ffffff" strokeWidth={sw * 0.5} opacity={0.4} />
              </Group>
            )}

          </Group>

          {/* Datum label — not Y-flipped */}
          <Text
            x={4 * sw}
            y={sheetConfig.height + 6 * sw}
            text="X0 Y0" fontSize={10 * sw} fill="#555"
          />
        </Layer>
      </Stage>

      {/* Unplaced warning */}
      {nestedParts.some(p => !p.placed) && (
        <div className="unplaced-warn">
          ⚠ {nestedParts.filter(p => !p.placed).length} part(s) could not fit — reduce gap or increase sheet size
        </div>
      )}

      {/* Sim progress */}
      {simState !== 'idle' && waypointsRef.current.length > 0 && (
        <div className="sim-progress">
          <div className="sim-bar" style={{ width: `${(curStep / (waypointsRef.current.length-1)) * 100}%` }} />
        </div>
      )}
    </div>
  )
}
