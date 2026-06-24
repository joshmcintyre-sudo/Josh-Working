import { useRef, useState } from 'react'

export default function DropZone({ onFileParsed }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef()

  const handleFile = (file) => {
    if (!file || !file.name.toLowerCase().endsWith('.dxf')) {
      alert('Please drop a .dxf file')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => onFileParsed(e.target.result, file.name)
    reader.readAsText(file)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    handleFile(file)
  }

  return (
    <div
      className={`dropzone ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".dxf"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files[0])}
      />
      <div className="dropzone-icon">📂</div>
      <div className="dropzone-text">Drop DXF file here or click to browse</div>
      <div className="dropzone-sub">Supports LWPOLYLINE, LINE, ARC, CIRCLE, ELLIPSE, SPLINE</div>
    </div>
  )
}
