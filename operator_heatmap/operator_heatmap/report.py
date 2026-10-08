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


def build_pdf(out_path: str, images: dict[str, np.ndarray], a: Analysis, meta: dict, page: str = "A3",
              op_images: dict[str, np.ndarray] | None = None, max_op_pages: int = 20):
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
                           ("spaghetti", "Spaghetti diagram (one colour per operator)")):
            if key != "spaghetti":
                _legend(c, size)
            _image_page(c, images[key], f"{meta['title']} - {title}", sub, size, tmp)
        for op, img in list((op_images or {}).items())[:max_op_pages]:
            km = f"  |  {a.distance_m[op]:,.0f} m walked" if op in a.distance_m else ""
            _image_page(c, img, f"{meta['title']} - {op}",
                        f"{sub}  |  active {a.active_s.get(op, 0) / 60:.1f} min{km}", size, tmp)

    # ---- data page
    m = 12 * mm
    c.setFont("Helvetica-Bold", 16)
    c.drawString(m, ph - m - 4, f"{meta['title']} - movement data")
    c.setFont("Helvetica", 9)
    c.drawString(m, ph - m - 18, sub)

    hc = [n for _, n in meta.get("headcount", [])]
    kpis = [["Metric", "Value"],
            ["Time analysed", f"{analysed / 60:.1f} min over {len(segs)} segment(s)"],
            ["Frames analysed", f"{meta['frames']} @ {meta['sample_fps']:g} fps"],
            ["Operators identified", str(len(a.paths))]]
    if hc:
        kpis += [["People on screen - max / average", f"{max(hc)} / {np.mean(hc):.1f}"]]
    if a.distance_m:
        total_m = sum(a.distance_m.values())
        kpis += [["Total distance walked (all operators)", f"{total_m:,.0f} m"],
                 ["Distance per operator-hour", f"{total_m / max(sum(a.active_s.values()) / 3600, 1e-9):,.0f} m/h"]]
    y = _table(c, kpis, m, ph - m - 40, [75 * mm, 60 * mm])

    rows = [["Operator", "Active (min)", "Walked (m)" if a.distance_m else "Path (px)", "Most time in", "% there"]]
    for p in sorted(a.paths, key=lambda p: -a.active_s.get(p.operator, 0))[:25]:
        dw = a.dwell_by_op.get(p.operator) or {}
        top = max(dw.items(), key=lambda kv: kv[1]) if dw else ("-", 0)
        act = a.active_s.get(p.operator, 0)
        rows.append([p.operator, f"{act / 60:.1f}",
                     f"{a.distance_m.get(p.operator, 0):,.0f}" if a.distance_m else f"{p.length_px():,.0f}",
                     top[0], f"{100 * top[1] / act:.0f}%" if act and dw else "-"])
    y = _table(c, rows, m, y - 8 * mm, [40 * mm, 24 * mm, 24 * mm, 40 * mm, 16 * mm])

    if a.dwell_s and y > 50 * mm:
        rows = [["Zone", "Dwell (min)", "% of tracked time"]]
        tot = sum(a.dwell_s.values()) or 1
        for z, sec in sorted(a.dwell_s.items(), key=lambda kv: -kv[1]):
            rows.append([z, f"{sec / 60:.1f}", f"{100 * sec / tot:.0f}%"])
        y = _table(c, rows, m, y - 8 * mm, [55 * mm, 30 * mm, 35 * mm])

    ry = ph - m - 40
    if hc:
        ry = _headcount_chart(c, meta["headcount"], pw / 2, ry, pw / 2 - m, 55 * mm)
    if a.flows:
        rows = [["From zone", "To zone", "Trips"]]
        for (src, dst), n in sorted(a.flows.items(), key=lambda kv: -kv[1])[:20]:
            rows.append([src, dst, str(n)])
        _table(c, rows, pw / 2, ry - 8 * mm, [55 * mm, 55 * mm, 20 * mm])

    c.setFont("Helvetica-Oblique", 7)
    c.setFillColor(colors.grey)
    c.drawString(m, 6 * mm, "Operators are anonymous (Operator 1, 2...) unless named in the app. Identities are rebuilt from "
                            "movement + clothing colour; check per-operator pages before using individual figures.")
    c.showPage()
    c.save()


def _headcount_chart(c, series, x, y_top, w, h) -> float:
    """People visible over time (step line). Gaps between segments are drawn as breaks."""
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x, y_top - 10, "People on screen over time")
    y0, top = y_top - h, y_top - 16
    ts = [t for t, _ in series]
    ns = [n for _, n in series]
    t0, t1, nmax = ts[0], ts[-1], max(max(ns), 1)
    c.setStrokeColor(colors.HexColor("#bbbbbb"))
    c.setLineWidth(0.4)
    c.line(x, y0, x + w, y0)
    c.setFont("Helvetica", 7)
    for k in range(nmax + 1):
        yy = y0 + (top - y0) * k / nmax
        c.line(x, yy, x + w, yy)
        c.drawRightString(x - 3, yy - 2, str(k))
    c.drawString(x, y0 - 9, fmt_ts(t0))
    c.drawRightString(x + w, y0 - 9, fmt_ts(t1))
    c.setStrokeColor(colors.HexColor("#d9480f"))
    c.setLineWidth(1)
    span = max(t1 - t0, 1e-9)
    gap = 3 * (ts[1] - ts[0]) if len(ts) > 1 else 1
    for (ta, na), (tb, _) in zip(series, series[1:]):
        if tb - ta > gap:
            continue
        xa, xb = x + w * (ta - t0) / span, x + w * (tb - t0) / span
        c.line(xa, y0 + (top - y0) * na / nmax, xb, y0 + (top - y0) * na / nmax)
    c.setStrokeColor(colors.black)
    return y0 - 12


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
