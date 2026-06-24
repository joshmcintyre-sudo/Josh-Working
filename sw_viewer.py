#!/usr/bin/env python3
"""
SOLIDWORKS Fast Viewer — drop-in replacement for eDrawings
Opens .sldprt and .sldasm files in seconds via the SOLIDWORKS COM API.

Requirements (run setup.bat or):
    pip install pywin32 pyvista numpy

Usage:
    python sw_viewer.py <file.sldprt|file.sldasm>
    — or drag a file onto sw_viewer.bat
"""

import sys
import os
import time
import traceback

try:
    import numpy as np
except ImportError:
    print("ERROR: numpy not installed.  Run setup.bat or: pip install numpy")
    input("Press Enter to exit…")
    sys.exit(1)

try:
    import pyvista as pv
except ImportError:
    print("ERROR: pyvista not installed.  Run setup.bat or: pip install pyvista")
    input("Press Enter to exit…")
    sys.exit(1)

try:
    import win32com.client
    import pythoncom
except ImportError:
    print("ERROR: pywin32 not installed.  Run setup.bat or: pip install pywin32")
    input("Press Enter to exit…")
    sys.exit(1)

# ── SOLIDWORKS API constants ───────────────────────────────────────────────
SW_DOC_PART     = 1
SW_DOC_ASSEMBLY = 2
SW_SOLID_BODY   = 0
SW_SHEET_BODY   = 1
SW_OPEN_SILENT  = 1   # swOpenDocOptions_Silent

# Colours cycling through assembly components
_PALETTE = [
    "#5B8DB8", "#E09B2D", "#55AA66", "#CC5555",
    "#8870CC", "#44BBBB", "#CC7733", "#99CC44",
    "#BB4499", "#66AADD", "#DDAA33", "#44AA88",
]


# ── SOLIDWORKS connection ──────────────────────────────────────────────────

def connect_solidworks():
    """Attach to an already-running SW instance; launch invisible if not found."""
    try:
        app = win32com.client.GetActiveObject("SldWorks.Application")
        print("  → Attached to running SOLIDWORKS")
        return app, False
    except Exception:
        print("  → Launching SOLIDWORKS invisibly…")
        app = win32com.client.Dispatch("SldWorks.Application")
        app.Visible = False
        try:
            app.UserControlBackground = True
        except Exception:
            pass
        return app, True


def open_doc(app, path, ftype):
    """Open a document silently; return IModelDoc2 or None."""
    err  = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
    warn = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
    doc = app.OpenDoc6(path, ftype, SW_OPEN_SILENT, "", err, warn)
    if doc is None:
        print(f"  ERROR: OpenDoc6 returned None (err={err.value} warn={warn.value})")
    return doc


# ── Geometry extraction ────────────────────────────────────────────────────

def body_to_polydata(body):
    """Convert an IBody2 tessellation to a pyvista PolyData."""
    try:
        raw = body.GetTessTriangles(True)   # True = use accurate tessellation
    except Exception:
        return None
    if raw is None or len(raw) == 0:
        return None

    verts = np.array(raw, dtype=np.float64).reshape(-1, 3)
    n_tris = len(verts) // 3
    if n_tris == 0:
        return None

    # Every 3 rows are one triangle — build face connectivity
    idx   = np.arange(len(verts), dtype=np.int64).reshape(-1, 3)
    faces = np.hstack([np.full((n_tris, 1), 3, dtype=np.int64), idx]).ravel()
    return pv.PolyData(verts, faces)


def apply_sw_transform(mesh, sw_xform):
    """Apply an IModelDoc2 MathTransform to a PolyData mesh (in-place copy)."""
    if sw_xform is None or mesh is None:
        return mesh
    try:
        d = list(sw_xform.ArrayData)
        # d[0..8]   3×3 rotation   (column-major)
        # d[9..11]  translation xyz (metres)
        # d[12]     scale factor
        R = np.array(d[0:9]).reshape(3, 3, order='F')
        T = np.array(d[9:12])
        S = float(d[12]) if d[12] != 0.0 else 1.0

        mat4          = np.eye(4, dtype=np.float64)
        mat4[:3, :3]  = R * S
        mat4[:3,  3]  = T
        return mesh.transform(mat4, inplace=False)
    except Exception as e:
        print(f"  Warning: transform skipped ({e})")
        return mesh


def extract_part(doc, xform=None):
    """Return list of PolyData for every solid/sheet body in a part doc."""
    meshes = []
    for btype in (SW_SOLID_BODY, SW_SHEET_BODY):
        try:
            bodies = doc.GetBodies2(btype, True)
        except Exception:
            continue
        if bodies is None:
            continue
        for body in bodies:
            mesh = body_to_polydata(body)
            if mesh is not None:
                mesh = apply_sw_transform(mesh, xform)
                meshes.append(mesh)
    return meshes


def extract_assembly(root_comp):
    """Recursively walk the assembly tree; return [(PolyData, color_hex)]."""
    results   = []
    color_idx = [0]

    def walk(comp):
        try:
            comp_doc = comp.GetModelDoc2()
        except Exception:
            return
        if comp_doc is None:
            return
        try:
            xform    = comp.Transform2
            doc_type = comp_doc.GetType()
        except Exception:
            return

        if doc_type == SW_DOC_PART:
            color = _PALETTE[color_idx[0] % len(_PALETTE)]
            color_idx[0] += 1
            for m in extract_part(comp_doc, xform):
                results.append((m, color))
        elif doc_type == SW_DOC_ASSEMBLY:
            try:
                children = comp.GetChildren()
            except Exception:
                children = None
            if children:
                for child in children:
                    walk(child)

    try:
        children = root_comp.GetChildren()
    except Exception:
        children = None
    if children:
        for child in children:
            walk(child)
    return results


# ── Rendering ─────────────────────────────────────────────────────────────

def render(mesh_color_pairs, title, n_bodies):
    """Open a pyvista window and display all meshes."""
    pl = pv.Plotter(title=title, window_size=(1440, 900))
    pl.set_background("#1A1F2B", top="#2B3345")
    pl.enable_lightkit()

    for mesh, color in mesh_color_pairs:
        pl.add_mesh(
            mesh,
            color=color,
            smooth_shading=True,
            specular=0.45,
            specular_power=25,
            ambient=0.15,
            diffuse=0.85,
        )

    pl.camera_position = "iso"
    pl.reset_camera()
    pl.add_axes(interactive=True, line_width=3)
    pl.add_text(
        f"{n_bodies} bod{'y' if n_bodies == 1 else 'ies'}   "
        "LMB Rotate · RMB Zoom · MMB Pan · R Reset · Q Quit",
        position="lower_left",
        font_size=9,
        color="#667788",
    )
    pl.show()


# ── Entry point ───────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        input("Press Enter to exit…")
        return

    path = os.path.abspath(sys.argv[1])
    if not os.path.exists(path):
        print(f"File not found:\n  {path}")
        input("Press Enter to exit…")
        return

    ext   = os.path.splitext(path)[1].lower()
    ftype = {".sldprt": SW_DOC_PART, ".sldasm": SW_DOC_ASSEMBLY}.get(ext)
    if ftype is None:
        print(f"Unsupported extension '{ext}'.  Expected .sldprt or .sldasm")
        input("Press Enter to exit…")
        return

    name = os.path.basename(path)
    print(f"\nSW Fast Viewer  ·  {name}")
    print("─" * 50)
    t0 = time.perf_counter()

    pythoncom.CoInitialize()

    app, did_launch = connect_solidworks()

    print("  Opening document…")
    doc = open_doc(app, path, ftype)
    if doc is None:
        print("  Failed. Ensure SOLIDWORKS is installed and licensed.")
        if did_launch:
            try:
                app.ExitApp()
            except Exception:
                pass
        pythoncom.CoUninitialize()
        input("Press Enter to exit…")
        return

    t1 = time.perf_counter()
    print(f"  Opened in {t1 - t0:.2f}s")
    print("  Extracting geometry…")

    if ftype == SW_DOC_PART:
        raw              = extract_part(doc)
        mesh_color_pairs = [(m, "#8AAEC8") for m in raw]
    else:
        try:
            root = doc.GetActiveConfiguration().GetRootComponent3(True)
        except Exception as e:
            print(f"  ERROR getting assembly root: {e}")
            mesh_color_pairs = []
            root = None
        if root is not None:
            mesh_color_pairs = extract_assembly(root)

    t2 = time.perf_counter()
    n  = len(mesh_color_pairs)
    print(f"  {n} bod{'y' if n == 1 else 'ies'} extracted in {t2 - t1:.2f}s")

    if n == 0:
        print("  No visible geometry found in this file.")
        app.CloseDoc(path)
        if did_launch:
            app.ExitApp()
        pythoncom.CoUninitialize()
        input("Press Enter to exit…")
        return

    print(f"  Total load time: {t2 - t0:.2f}s  — rendering now")
    render(mesh_color_pairs, f"SW Fast Viewer — {name}", n)

    # Cleanup
    try:
        app.CloseDoc(path)
    except Exception:
        pass
    if did_launch:
        try:
            app.ExitApp()
        except Exception:
            pass
    pythoncom.CoUninitialize()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        traceback.print_exc()
        input("\nPress Enter to exit…")
