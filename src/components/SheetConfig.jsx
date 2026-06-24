export default function SheetConfig({ config, onChange }) {
  const set = (key, val) => onChange({ ...config, [key]: parseFloat(val) || 0 })

  return (
    <div className="panel">
      <h3>Sheet Configuration</h3>
      <div className="field-row">
        <label>Width (mm)</label>
        <input type="number" value={config.width} min={1} onChange={e => set('width', e.target.value)} />
      </div>
      <div className="field-row">
        <label>Height (mm)</label>
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
        <label>Datum Corner</label>
        <select value={config.datum} onChange={e => onChange({ ...config, datum: e.target.value })}>
          <option value="bottom-left">Bottom Left (X0 Y0)</option>
          <option value="top-left">Top Left</option>
        </select>
      </div>
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
