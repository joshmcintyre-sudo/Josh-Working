"""Order log (SQLite, one row per inspection record). Survives restarts; viewed at /log."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

COLS = ["record_id", "finished", "order_ref", "order_type", "board_id", "operator", "vision_result",
        "final_result", "qc_by", "qc_note", "qc_at", "problems", "json_path", "image_path", "export_status"]


class OrderLog:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._db() as db:
            db.execute(f"CREATE TABLE IF NOT EXISTS records ({', '.join(c + ' TEXT' for c in COLS)}, "
                       "PRIMARY KEY (record_id))")
            db.execute("CREATE INDEX IF NOT EXISTS ix_order ON records(order_ref)")

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def upsert(self, row: dict) -> None:
        vals = {c: row.get(c) for c in COLS}
        with self._lock, self._db() as db:
            db.execute(f"INSERT OR REPLACE INTO records ({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})",
                       [None if v is None else str(v) for v in vals.values()])

    def set_export_status(self, record_id: str, status: str) -> None:
        with self._lock, self._db() as db:
            db.execute("UPDATE records SET export_status=? WHERE record_id=?", (status, record_id))

    def query(self, q: str = "", result: str = "", limit: int = 200) -> list[dict]:
        sql, args = "SELECT * FROM records WHERE 1=1", []
        if q:
            sql += " AND (order_ref LIKE ? OR board_id LIKE ? OR operator LIKE ?)"
            args += [f"%{q}%"] * 3
        if result:
            sql += " AND final_result=?"
            args.append(result)
        sql += " ORDER BY finished DESC LIMIT ?"
        args.append(int(limit))
        with self._db() as db:
            return [dict(r) for r in db.execute(sql, args)]
