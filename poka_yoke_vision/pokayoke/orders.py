"""Work / sales order barcodes, e.g. W234566 (work order) or S98993 (sales order)."""
from __future__ import annotations

import re

DEFAULT_TYPES = {"W": "Work order", "S": "Sales order"}
DEFAULT_PATTERN = r"^[A-Z]\d{4,10}$"


def parse_order(code: str, types: dict | None = None, pattern: str | None = None) -> dict:
    """Return {order_ref, order_type, order_label} or raise ValueError with an operator message."""
    types = types or DEFAULT_TYPES
    ref = re.sub(r"\s+", "", (code or "")).upper()
    # Scanners sometimes add a symbology prefix/suffix; keep the first order-shaped token.
    m = re.search(r"[A-Z]\d{4,10}", ref)
    if m:
        ref = m.group(0)
    if not ref:
        raise ValueError("Scan the work or sales order barcode")
    if not re.fullmatch(pattern or DEFAULT_PATTERN, ref) or ref[0] not in types:
        allowed = ", ".join(f"{k}... = {v}" for k, v in types.items())
        raise ValueError(f"'{code}' is not a valid order number ({allowed})")
    label = types[ref[0]]
    return {"order_ref": ref, "order_type": label.upper().replace(" ", "_"), "order_label": label}
