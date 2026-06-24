const MATERIALS = [
  { name: 'Custom',             thickness: null, feedRate: null, plungeRate: null, depthPerPass: null },
  // ── Plywood ──────────────────────────────────────────────────────────────────
  { name: '3mm Plywood',        thickness: 3,    feedRate: 18000, plungeRate: 1500, depthPerPass: 3   },
  { name: '6mm Plywood',        thickness: 6,    feedRate: 18000, plungeRate: 1500, depthPerPass: 6   },
  { name: '9mm Plywood',        thickness: 9,    feedRate: 18000, plungeRate: 1500, depthPerPass: 6   },
  { name: '12mm Plywood',       thickness: 12,   feedRate: 18000, plungeRate: 1500, depthPerPass: 6   },
  { name: '18mm Plywood',       thickness: 18,   feedRate: 16000, plungeRate: 1200, depthPerPass: 6   },
  { name: '25mm Plywood',       thickness: 25,   feedRate: 14000, plungeRate: 1000, depthPerPass: 6   },
  // ── MDF ──────────────────────────────────────────────────────────────────────
  { name: '3mm MDF',            thickness: 3,    feedRate: 18000, plungeRate: 1500, depthPerPass: 3   },
  { name: '6mm MDF',            thickness: 6,    feedRate: 18000, plungeRate: 1500, depthPerPass: 6   },
  { name: '12mm MDF',           thickness: 12,   feedRate: 18000, plungeRate: 1500, depthPerPass: 6   },
  { name: '18mm MDF',           thickness: 18,   feedRate: 16000, plungeRate: 1200, depthPerPass: 6   },
  // ── Aluminium ────────────────────────────────────────────────────────────────
  { name: '1.5mm Aluminium',    thickness: 1.5,  feedRate: 3000,  plungeRate: 500,  depthPerPass: 0.5 },
  { name: '3mm Aluminium',      thickness: 3,    feedRate: 3000,  plungeRate: 500,  depthPerPass: 0.5 },
  { name: '6mm Aluminium',      thickness: 6,    feedRate: 2500,  plungeRate: 400,  depthPerPass: 0.5 },
  // ── Acrylic ──────────────────────────────────────────────────────────────────
  { name: '3mm Acrylic',        thickness: 3,    feedRate: 12000, plungeRate: 800,  depthPerPass: 1.5 },
  { name: '6mm Acrylic',        thickness: 6,    feedRate: 10000, plungeRate: 600,  depthPerPass: 1.5 },
  { name: '10mm Acrylic',       thickness: 10,   feedRate: 8000,  plungeRate: 500,  depthPerPass: 1.5 },
  // ── Foam / Soft ──────────────────────────────────────────────────────────────
  { name: '25mm Foam / Foam PVC', thickness: 25, feedRate: 20000, plungeRate: 2000, depthPerPass: 25  },
]

export { MATERIALS }

export default function SheetConfig({ config, onChange, onMaterialSelect }) {
  const set = (key, val) => onChange({ ...config, [key]: parseFloat(val) || 0 })

  const handleMaterial = (name) => {
    const m = MATERIALS.find(x => x.name === name)
    if (!m || m.thickness === null) {
      onChange({ ...config, material: name })
      return
    }
    onChange({ ...config, material: name, thickness: m.thickness })
    onMaterialSelect && onMaterialSelect(m)
  }

  return (
    <div className="panel">
      <h3>Sheet Configuration</h3>

      {/* Material library */}
      <div className="field-row">
        <label>Material</label>
        <select value={config.material || 'Custom'} onChange={e => handleMaterial(e.target.value)}>
          {MATERIALS.map(m => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label>Thickness (mm)</label>
        <input type="number" value={config.thickness ?? 12} min={0.1} step={0.5}
          onChange={e => onChange({ ...config, thickness: parseFloat(e.target.value) || 0, material: 'Custom' })} />
      </div>

      <div className="panel-divider" />

      <div className="field-row">
        <label>Sheet Width (mm)</label>
        <input type="number" value={config.width} min={1} onChange={e => set('width', e.target.value)} />
      </div>
      <div className="field-row">
        <label>Sheet Height (mm)</label>
        <input type="number" value={config.height} min={1} onChange={e => set('height', e.target.value)} />
      </div>
      <div className="field-row">
        <label>Part Gap / Kerf (mm)</label>
        <input type="number" value={config.gap} min={0} step={0.5} onChange={e => set('gap', e.target.value)} />
      </div>
      <div className="field-row">
        <label>Sheet Margin (mm)</label>
        <input type="number" value={config.margin} min={0} step={1} onChange={e => set('margin', e.target.value)} />
      </div>
      <div className="field-row">
        <label>Safety Plane Z (mm)</label>
        <input type="number" value={config.safeZ ?? 33} min={1} step={1}
          onChange={e => onChange({ ...config, safeZ: parseFloat(e.target.value) || 33 })} />
      </div>

      <div className="panel-divider" />

      <div className="field-row">
        <label>Datum Corner</label>
        <select value={config.datumCorner || 'bottom-left'} onChange={e => onChange({ ...config, datumCorner: e.target.value })}>
          <option value="bottom-left">Bottom Left</option>
          <option value="top-left">Top Left</option>
          <option value="custom">Custom XY</option>
        </select>
      </div>
      {(config.datumCorner === 'custom') && (
        <>
          <div className="field-row">
            <label>Datum X offset (mm)</label>
            <input type="number" value={config.datumX ?? 0} step={0.5}
              onChange={e => onChange({ ...config, datumX: parseFloat(e.target.value) || 0 })} />
          </div>
          <div className="field-row">
            <label>Datum Y offset (mm)</label>
            <input type="number" value={config.datumY ?? 0} step={0.5}
              onChange={e => onChange({ ...config, datumY: parseFloat(e.target.value) || 0 })} />
          </div>
        </>
      )}

      <div className="field-row">
        <label>Units</label>
        <select value={config.units} onChange={e => onChange({ ...config, units: e.target.value })}>
          <option value="mm">Millimetres</option>
          <option value="in">Inches</option>
        </select>
      </div>
    </div>
  )
}
