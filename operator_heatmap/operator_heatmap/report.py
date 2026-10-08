"""PDF report: overlay pages + a data page."""
from __future__ import annotations

import datetime as dt
import os
import tempfile

import cv2
import numpy as np
from reportlab.lib import colors
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.units import mm
from reportlab.platypus import Table, TableStyle
from reportlab.pdfgen import canvas

from .analysis import Analysis
from .segments import fmt_ts

PAGE_SIZES = {"A4": landscape(A4), "A3": landscape(A3)}


def _image_page(c: canvas.Canvas, img: np.ndarray, title: str, subtitle: str, page: tuple[float, float], tmp: str):
    pw, ph = page
    m = 12 * mm
    c.setFont("Helvetica-Bold", 16)
    c.drawString(m, ph - m - 4, title)
    c.setFont("Helvetica", 9)
    c.setFillColor(colors.grey)
    c.drawString(m, ph - m - 18, subtitle)
    c.setFillColor(colors.black)

    path = os.path.join(tmp, f"{abs(hash(title))}.jpg")
    cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    ih, iw = img.shape[:2]
    box_w, box_h = pw - 2 * m, ph - 2 * m - 30
    s = min(box_w / iw, box_h / ih)
    w, h = iw * s, ih * s
    c.drawImage(path, (pw - w) / 2, m + (box_h - h) / 2, w, h)
    c.showPage()


def _legend(c: canvas.Canvas, page):
    pw, _ = page
    m = 12 * mm
    x0, y0, bw = pw - m - 60 * mm, 6 * mm, 60 * mm
    lut = cv2.applyColorMap(np.arange(256, dtype=np.uint8)[None, :], cv2.COLORMAP_TURBO)[0]
    for i in range(0, 256, 4):
        b, g, r = lut[i]
        c.setFillColorRGB(r / 255, g / 255, b / 255)
        c.rect(x0 + bw * i / 256, y0, bw * 4 / 256 + 0.3, 3 * mm, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica", 7)
    c.drawString(x0 - 22 * mm, y0 + 0.5 * mm, "Time spent:  low")
    c.drawString(x0 + bw + 2, y0 + 0.5 * mm, "high")


def build_pdf(out_path: str, images: dict[str, np.ndarray], a: Analysis, meta: dict, page: str = "A3"):
    size = PAGE_SIZES[page]
    pw, ph = size
    segs = meta["segments"]
    seg_txt = ", ".join(f"{fmt_ts(s)}-{fmt_ts(e)}" for s, e in segs)
    analysed = sum(e - s for s, e in segs)
    sub = (f"{meta['video']}  |  camera: {meta['camera']}  |  segments: {seg_txt}  "
           f"({analysed / 60:.1f} min)  |  generated {dt.datetime.now():%Y-%m-%d %H:%M}")

    c = canvas.Canvas(out_path, pagesize=size)
    c.setTitle(f"Operator movement - {meta['title']}")
    with tempfile.TemporaryDirectory() as tmp:
        for key, title in (("combined", "Operator movement - heat map + spaghetti"),
                           ("heatmap", "Dwell heat map"),
                           ("spaghetti", "Spaghetti diagram (one colour per tracked operator path)")):
            if key != "spaghetti":
                _legend(c, size)
            _image_page(c, images[key], f"{meta['title']} - {title}", sub, size, tmp)

    # ---- data page
    m = 12 * mm
    c.setFont("Helvetica-Bold", 16)
    c.drawString(m, ph - m - 4, f"{meta['title']} - movement data")
    c.setFont("Helvetica", 9)
    c.drawString(m, ph - m - 18, sub)

    n_paths = len(a.paths)
    total_px = sum(p.length_px() for p in a.paths)
    kpis = [["Metric", "Value"],
            ["Time analysed", f"{analysed / 60:.1f} min over {len(segs)} segment(s)"],
            ["Frames analysed", f"{meta['frames']} @ {meta['sample_fps']:g} fps"],
            ["Operator paths tracked", str(n_paths)],
            ["Total path length (image px)", f"{total_px:,.0f}"]]
    if a.distance_m:
        total_m = sum(a.distance_m.values())
        kpis += [["Total distance walked", f"{total_m:,.0f} m"],
                 ["Distance per hour analysed", f"{total_m / max(analysed / 3600, 1e-9):,.0f} m/h"]]
    y = ph - m - 40
    y = _table(c, kpis, m, y, [70 * mm, 90 * mm])

    if a.dwell_s:
        rows = [["Zone", "Dwell (min)", "% of tracked time"]]
        tot = sum(a.dwell_s.values()) or 1
        for z, s in sorted(a.dwell_s.items(), key=lambda kv: -kv[1]):
            rows.append([z, f"{s / 60:.1f}", f"{100 * s / tot:.0f}%"])
        y = _table(c, rows, m, y - 8 * mm, [70 * mm, 30 * mm, 35 * mm])
    if a.flows:
        rows = [["From zone", "To zone", "Trips"]]
        for (s, d), n in sorted(a.flows.items(), key=lambda kv: -kv[1])[:20]:
            rows.append([s, d, str(n)])
        _table(c, rows, pw / 2, ph - m - 40, [55 * mm, 55 * mm, 20 * mm])

    longest = sorted(a.paths, key=lambda p: -p.length_px())[:10]
    if longest and y > 60 * mm:
        rows = [["Path ID", "Start", "Duration (s)", "Length (px)"] + (["Distance (m)"] if a.distance_m else [])]
        for p in longest:
            row = [str(p.track_id), fmt_ts(p.t[0]), f"{p.duration:.0f}", f"{p.length_px():,.0f}"]
            if a.distance_m:
                row.append(f"{a.distance_m.get(p.track_id, 0):.1f}")
            rows.append(row)
        _table(c, rows, m, y - 8 * mm, [22 * mm, 25 * mm, 28 * mm, 28 * mm, 28 * mm][: len(rows[0])])

    c.setFont("Helvetica-Oblique", 7)
    c.setFillColor(colors.grey)
    c.drawString(m, 6 * mm, "Path IDs are anonymous track numbers. One operator may appear as several paths if "
                            "occluded; use dwell/flow totals rather than per-ID counts for headcount decisions.")
    c.showPage()
    c.save()


def _table(c, rows, x, y_top, widths) -> float:
    t = Table(rows, colWidths=widths)
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#222222")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f0f0f0")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#bbbbbb")),
    ]))
    _, h = t.wrapOn(c, 0, 0)
    t.drawOn(c, x, y_top - h)
    return y_top - h
