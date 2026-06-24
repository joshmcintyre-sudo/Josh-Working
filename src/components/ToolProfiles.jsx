import { useState } from 'react'

const FIELD_DEFS = [
  { key: 'name', label: 'Profile Name', type: 'text' },
  { key: 'toolNumber', label: 'Tool Number', type: 'number', min: 1 },
  { key: 'diameter', label: 'Diameter (mm)', type: 'number', min: 0.1, step: 0.01 },
  { key: 'rpm', label: 'Spindle RPM', type: 'number', min: 1 },
  { key: 'feedRate', label: 'Feed Rate (mm/min)', type: 'number', min: 1 },
  { key: 'plungeRate', label: 'Plunge Rate (mm/min)', type: 'number', min: 1 },
  { key: 'depthPerPass', label: 'Depth Per Pass (mm)', type: 'number', min: 0.1, step: 0.1 },
  { key: 'totalDepth', label: 'Total Cut Depth (mm)', type: 'number', min: 0.1, step: 0.1 },
  { key: 'safeZ', label: 'Safe Z (mm)', type: 'number', min: 0, step: 1 },
  { key: 'plungeZ', label: 'Plunge Clearance Z (mm)', type: 'number', min: 0, step: 0.5 },
  { key: 'color', label: 'Display Colour', type: 'color' },
]

const BRIDGE_FIELDS = [
  { key: 'bridgesEnabled', label: 'Enable Bridges / Tabs', type: 'checkbox' },
  { key: 'bridgeCount', label: 'Bridges Per Profile', type: 'number', min: 1, max: 12 },
  { key: 'bridgeWidth', label: 'Bridge Width (mm)', type: 'number', min: 1, step: 0.5 },
  { key: 'bridgeHeight', label: 'Bridge Height (mm — uncut stock)', type: 'number', min: 0.5, step: 0.5 },
]

export default function ToolProfiles({ profiles, onChange }) {
  const [expanded, setExpanded] = useState(profiles[0]?.id)

  const update = (id, key, val) => {
    onChange(profiles.map(p =>
      p.id === id ? { ...p, [key]: key === 'name' || key === 'color' ? val : (key === 'bridgesEnabled' ? val : parseFloat(val) || 0) } : p
    ))
  }

  const addProfile = () => {
    const newId = 'profile-' + Date.now()
    onChange([...profiles, {
      id: newId,
      name: 'New Tool Profile',
      toolNumber: profiles.length + 1,
      diameter: 6.35,
      rpm: 18000,
      feedRate: 5000,
      plungeRate: 1500,
      depthPerPass: 10,
      totalDepth: 18,
      safeZ: 25,
      plungeZ: 2,
      color: '#a855f7',
      bridgesEnabled: false,
      bridgeCount: 4,
      bridgeWidth: 6,
      bridgeHeight: 3,
    }])
    setExpanded(newId)
  }

  const removeProfile = (id) => {
    if (profiles.length === 1) return
    onChange(profiles.filter(p => p.id !== id))
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Tool Profiles</h3>
        <button className="btn-sm" onClick={addProfile}>+ Add</button>
      </div>

      {profiles.map(p => (
        <div key={p.id} className="profile-card">
          <div
            className="profile-header"
            onClick={() => setExpanded(expanded === p.id ? null : p.id)}
          >
            <span className="profile-dot" style={{ background: p.color }} />
            <span className="profile-title">T{p.toolNumber} — {p.name}</span>
            <span className="profile-chevron">{expanded === p.id ? '▲' : '▼'}</span>
          </div>

          {expanded === p.id && (
            <div className="profile-body">
              <div className="section-label">Cutting Parameters</div>
              {FIELD_DEFS.map(f => (
                <div key={f.key} className="field-row">
                  <label>{f.label}</label>
                  <input
                    type={f.type}
                    value={p[f.key]}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    onChange={e => update(p.id, f.key, e.target.value)}
                  />
                </div>
              ))}

              <div className="section-label" style={{ marginTop: 12 }}>Bridges / Tabs</div>
              {BRIDGE_FIELDS.map(f => (
                <div key={f.key} className="field-row">
                  <label>{f.label}</label>
                  {f.type === 'checkbox' ? (
                    <input
                      type="checkbox"
                      checked={!!p[f.key]}
                      onChange={e => update(p.id, f.key, e.target.checked)}
                    />
                  ) : (
                    <input
                      type="number"
                      value={p[f.key] ?? (f.key === 'bridgeCount' ? 4 : f.key === 'bridgeWidth' ? 6 : 3)}
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      disabled={!p.bridgesEnabled}
                      onChange={e => update(p.id, f.key, e.target.value)}
                    />
                  )}
                </div>
              ))}

              <button
                className="btn-danger"
                onClick={() => removeProfile(p.id)}
                disabled={profiles.length === 1}
              >
                Remove Profile
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
