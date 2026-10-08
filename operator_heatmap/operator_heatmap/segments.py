"""Parse time segments like "00:01:30-00:03:00, 10:00-12:30, 45-90"."""
from __future__ import annotations


def parse_ts(text: str) -> float:
    """'hh:mm:ss(.ms)', 'mm:ss' or plain seconds -> seconds."""
    parts = [float(p) for p in text.strip().split(":")]
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def fmt_ts(secs: float) -> str:
    h, rem = divmod(int(round(secs)), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def parse_segments(text: str | None, duration: float) -> list[tuple[float, float]]:
    """Return sorted, merged (start, end) seconds. Empty/None = whole video."""
    if not text or not text.strip():
        return [(0.0, duration)]
    segs = []
    for chunk in text.replace(";", ",").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        a, b = chunk.split("-")
        start = max(0.0, parse_ts(a))
        end = min(duration, parse_ts(b)) if b.strip() else duration
        if end <= start:
            raise ValueError(f"Segment '{chunk}' ends before it starts")
        segs.append((start, end))
    segs.sort()
    merged = [segs[0]]
    for s, e in segs[1:]:
        if s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged
