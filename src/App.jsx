import { useState, useCallback } from 'react'
import DropZone from './components/DropZone.jsx'
import SheetCanvas from './components/SheetCanvas.jsx'
import SheetConfig from './components/SheetConfig.jsx'
import ToolProfiles from './components/ToolProfiles.jsx'
import PartsList from './components/PartsList.jsx'
import { parseDxf, normalizePolygon, getPolygonBounds } from './lib/dxfParser.js'
import { nestParts, computeSheetUtilization } from './lib/nesting.js'
import { generateGCode, DEFAULT_TOOL_PROFILES } from './lib/gcodeGenerator.js'
import { computeBridgePositions } from './lib/gcodeGenerator.js'

const DEFAULT_SHEET = {
  width: 2440,
  height: 1220,
  gap: 8,
  margin: 10,
  datum: 'bottom-left',
  units: 'mm',
}

export default function App() {
  const [parts, setParts] = useState([])
  const [sheetConfig, setSheetConfig] = useState(DEFAULT_SHEET)
  const [toolProfiles, setToolProfiles] = useState(DEFAULT_TOOL_PROFILES)
  const [nestedParts, setNestedParts] = useState([])
  const [utilization, setUtilization] = useState(null)
  const [nesting, setNesting] = useState(false)
  const [gcodePreview, setGcodePreview] = useState(null)
  const [error, setError] = useState(null)

  const handleDxfParsed = useCallback((text, filename) => {
    setError(null)
    try {
      const polygons = parseDxf(text)
      if (polygons.length === 0) {
        setError('No closed profiles found in this DXF. Ensure your shapes are closed polylines or circles.')
        return
      }
      const newParts = polygons.map((poly, i) => {
        const b = getPolygonBounds(poly)
        return {
          id: `part-${Date.now()}-${i}`,
          name: `${filename.replace('.dxf', '')} [${i + 1}]`,
          polygon: normalizePolygon(poly),
          quantity: 1,
          toolProfileId: toolProfiles[0]?.id,
        }
      })
      setParts(prev => [...prev, ...newParts])
      setNestedParts([])
    } catch (e) {
      setError(e.message)
    }
  }, [toolProfiles])

  const handleNest = useCallback(() => {
    setNesting(true)
    setError(null)

    setTimeout(() => {
      try {
        // Expand parts by quantity
        const expanded = []
        for (const part of parts) {
          for (let q = 0; q < part.quantity; q++) {
            expanded.push({ ...part, polygon: part.polygon })
          }
        }

        const usableW = sheetConfig.width - sheetConfig.margin * 2
        const usableH = sheetConfig.height - sheetConfig.margin * 2

        const rawResults = nestParts(expanded, sheetConfig.width, sheetConfig.height, sheetConfig.gap, sheetConfig.margin)

        // Nesting already places within margin; just attach bridge markers
        const results = rawResults.map(r => {
          if (!r.placed) return r
          const shifted = r.polygon

          // Add bridge markers for display
          const profile = toolProfiles.find(t => t.id === r.toolProfileId) || toolProfiles[0]
          const bridges = profile?.bridgesEnabled
            ? computeBridgePositions(shifted, profile.bridgeCount, profile.bridgeWidth)
            : []

          return { ...r, polygon: shifted, bridges }
        })

        setNestedParts(results)
        setUtilization(computeSheetUtilization(results, sheetConfig.width, sheetConfig.height))
      } catch (e) {
        setError('Nesting error: ' + e.message)
      }
      setNesting(false)
    }, 50)
  }, [parts, sheetConfig, toolProfiles])

  const handleExportGCode = useCallback(() => {
    if (!nestedParts.length) return
    const gcode = generateGCode(nestedParts, toolProfiles, sheetConfig, { programNumber: 1000 })
    const blob = new Blob([gcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nest_output.cnc'
    a.click()
    URL.revokeObjectURL(url)
  }, [nestedParts, toolProfiles, sheetConfig])

  const handlePreviewGCode = useCallback(() => {
    if (!nestedParts.length) return
    const gcode = generateGCode(nestedParts, toolProfiles, sheetConfig, { programNumber: 1000 })
    setGcodePreview(gcodePreview ? null : gcode)
  }, [nestedParts, toolProfiles, sheetConfig, gcodePreview])

  const handleQuantityChange = (idx, qty) => {
    setParts(p => p.map((part, i) => i === idx ? { ...part, quantity: qty } : part))
    setNestedParts([])
  }

  const handleToolAssign = (idx, toolId) => {
    setParts(p => p.map((part, i) => i === idx ? { ...part, toolProfileId: toolId } : part))
    setNestedParts([])
  }

  const handleRemovePart = (idx) => {
    setParts(p => p.filter((_, i) => i !== idx))
    setNestedParts([])
  }

  const handlePartMove = (placedIdx, dx, dy) => {
    setNestedParts(prev => prev.map((p, i) => {
      if (i !== placedIdx || !p.placed) return p
      const moved = p.polygon.map(pt => ({ x: pt.x + dx, y: pt.y + dy }))
      return { ...p, polygon: moved }
    }))
  }

  const placedCount = nestedParts.filter(p => p.placed).length
  const unplacedCount = nestedParts.filter(p => !p.placed).length

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="logo">⬡</span>
          <span>CNC Nester</span>
          <span className="subtitle">MultiCam G-Code Generator</span>
        </div>
        <div className="header-actions">
          {nestedParts.length > 0 && (
            <>
              <span className="stat">
                {placedCount} placed{unplacedCount > 0 ? `, ${unplacedCount} unplaced` : ''}
                {utilization !== null && ` · ${utilization.toFixed(1)}% utilisation`}
              </span>
              <button className="btn-outline" onClick={handlePreviewGCode}>
                {gcodePreview ? 'Hide G-Code' : 'Preview G-Code'}
              </button>
              <button className="btn-primary" onClick={handleExportGCode}>
                Export .cnc
              </button>
            </>
          )}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="layout">
        <aside className="sidebar">
          <DropZone onFileParsed={handleDxfParsed} />
          <SheetConfig config={sheetConfig} onChange={setSheetConfig} />
          <PartsList
            parts={parts}
            toolProfiles={toolProfiles}
            onQuantityChange={handleQuantityChange}
            onToolAssign={handleToolAssign}
            onRemove={handleRemovePart}
          />
          <ToolProfiles profiles={toolProfiles} onChange={setToolProfiles} />
          {parts.length > 0 && (
            <button
              className="btn-nest"
              onClick={handleNest}
              disabled={nesting}
            >
              {nesting ? 'Nesting…' : '▶ Auto Nest'}
            </button>
          )}
        </aside>

        <main className="main">
          {parts.length === 0 && !nestedParts.length ? (
            <div className="empty-state">
              <div className="empty-icon">⬡</div>
              <div>Drop a DXF file to get started</div>
              <div className="empty-sub">Configure your sheet and tool profiles, then click Auto Nest</div>
            </div>
          ) : (
              <SheetCanvas
              sheetConfig={sheetConfig}
              nestedParts={nestedParts}
              toolProfiles={toolProfiles}
              onPartMove={handlePartMove}
            />
          )}

          {gcodePreview && (
            <div className="gcode-preview">
              <div className="gcode-header">
                G-Code Preview
                <button className="btn-close" onClick={() => setGcodePreview(null)}>✕</button>
              </div>
              <pre className="gcode-content">{gcodePreview}</pre>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
