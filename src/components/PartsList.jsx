import { getPolygonBounds } from '../lib/dxfParser.js'

export default function PartsList({ parts, toolProfiles, onQuantityChange, onToolAssign, onRemove }) {
  if (!parts.length) return null

  return (
    <div className="panel">
      <h3>Parts ({parts.length} profile{parts.length !== 1 ? 's' : ''})</h3>
      <div className="parts-list">
        {parts.map((part, i) => {
          const b = getPolygonBounds(part.polygon)
          return (
            <div key={part.id} className="part-item">
              <div className="part-name">{part.name}</div>
              <div className="part-meta">
                {b.width.toFixed(1)} × {b.height.toFixed(1)} mm
              </div>
              <div className="part-controls">
                <label>Qty</label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={part.quantity}
                  onChange={e => onQuantityChange(i, parseInt(e.target.value) || 1)}
                />
                <label>Tool</label>
                <select
                  value={part.toolProfileId}
                  onChange={e => onToolAssign(i, e.target.value)}
                >
                  {toolProfiles.map(tp => (
                    <option key={tp.id} value={tp.id}>T{tp.toolNumber} {tp.name}</option>
                  ))}
                </select>
                <button className="btn-icon" onClick={() => onRemove(i)} title="Remove part">✕</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
