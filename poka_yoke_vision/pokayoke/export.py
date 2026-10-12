"""Outbound queue: every saved record (JSON + image) is queued in results/outbox/ and sent to
  - webhook: POST multipart (record.json + image.jpg) to your other app
  - box:     Box "upload file to folder" API (POST upload.box.com/api/2.0/files/content)
Jobs survive restarts and network drops; failed sends retry every `retry_seconds`.
Both targets are off until enabled in settings.json / secrets.json.
"""
from __future__ import annotations

import json
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def _multipart(parts: list[tuple[str, str | None, bytes, str]]) -> tuple[bytes, str]:
    """parts: (field, filename|None, data, content_type) -> (body, content-type header)."""
    b = uuid.uuid4().hex
    out = bytearray()
    for name, fname, data, ctype in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{fname}"' if fname else "")
        out += f"--{b}\r\nContent-Disposition: {disp}\r\nContent-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={b}"


def _post(url: str, body: bytes, ctype: str, headers: dict | None = None, timeout: int = 30) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": ctype, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class BoxUploader:
    """Box server-side auth: Client Credentials Grant (recommended) or a developer token (60 min, testing)."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.api = cfg.get("api_base", "https://api.box.com")
        self.upload = cfg.get("upload_base", "https://upload.box.com")
        self._token, self._exp = None, 0.0

    def token(self) -> str:
        if self.cfg.get("developer_token"):
            return self.cfg["developer_token"]
        if self._token and time.time() < self._exp - 60:
            return self._token
        form = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": self.cfg["client_id"],
            "client_secret": self.cfg["client_secret"],
            "box_subject_type": self.cfg.get("subject_type", "enterprise"),
            "box_subject_id": self.cfg["subject_id"]}).encode()
        code, body = _post(f"{self.api}/oauth2/token", form, "application/x-www-form-urlencoded")
        if code != 200:
            raise RuntimeError(f"Box auth failed {code}: {body[:200]!r}")
        j = json.loads(body)
        self._token, self._exp = j["access_token"], time.time() + int(j.get("expires_in", 3600))
        return self._token

    def put(self, path: Path, name: str | None = None) -> str:
        attrs = json.dumps({"name": name or path.name, "parent": {"id": str(self.cfg["folder_id"])}}).encode()
        body, ctype = _multipart([("attributes", None, attrs, "application/json"),
                                  ("file", name or path.name, path.read_bytes(), "application/octet-stream")])
        code, resp = _post(f"{self.upload}/api/2.0/files/content", body, ctype,
                           {"Authorization": f"Bearer {self.token()}"})
        if code == 201:
            return json.loads(resp)["entries"][0]["id"]
        if code == 409:                       # same name already in folder = already delivered
            return "exists"
        if code == 401:
            self._token = None
        raise RuntimeError(f"Box upload {path.name} failed {code}: {resp[:200]!r}")


class Exporter:
    def __init__(self, settings: dict, results_dir: Path, on_status=None):
        self.cfg = settings.get("export", {})
        self.dir = Path(results_dir) / "outbox"
        (self.dir / "pending").mkdir(parents=True, exist_ok=True)
        (self.dir / "sent").mkdir(parents=True, exist_ok=True)
        self.on_status = on_status or (lambda rid, st: None)
        self.box = BoxUploader(self.cfg["box"]) if self.cfg.get("box", {}).get("enabled") else None
        self.webhook = self.cfg.get("webhook", {}) if self.cfg.get("webhook", {}).get("enabled") else None
        self._flush_lock = threading.Lock()
        self._wake = threading.Event()
        self._run = True
        threading.Thread(target=self._loop, daemon=True).start()

    def targets(self) -> list[str]:
        return [t for t, on in (("webhook", self.webhook), ("box", self.box)) if on]

    def enqueue(self, record: dict, json_path: Path, image_path: Path | None) -> str:
        targets = self.targets()
        if not targets:
            return "not configured"
        job = {"record_id": record["record_id"], "json": str(json_path),
               "image": str(image_path) if image_path else None,
               "done": {t: False for t in targets}, "attempts": 0, "last_error": None}
        (self.dir / "pending" / f"{record['record_id']}.json").write_text(json.dumps(job, indent=2))
        self._wake.set()
        return "queued"

    def _loop(self):
        while self._run:
            self.flush()
            self._wake.wait(timeout=float(self.cfg.get("retry_seconds", 60)))
            self._wake.clear()

    def flush(self) -> None:
        with self._flush_lock:
            self._flush()

    def _flush(self) -> None:
        for f in sorted((self.dir / "pending").glob("*.json")):
            job = json.loads(f.read_text())
            for t in [t for t, ok in job["done"].items() if not ok]:
                try:
                    self._send(t, job)
                    job["done"][t] = True
                except Exception as e:  # network down, auth, etc. - keep for retry
                    job["last_error"] = f"{t}: {e}"
            job["attempts"] += 1
            if all(job["done"].values()):
                job["last_error"] = None
                f.write_text(json.dumps(job, indent=2))
                shutil.move(str(f), self.dir / "sent" / f.name)
                self.on_status(job["record_id"], "sent: " + ", ".join(job["done"]))
            else:
                f.write_text(json.dumps(job, indent=2))
                self.on_status(job["record_id"], f"retrying ({job['last_error']})"[:250])

    def _send(self, target: str, job: dict):
        jp = Path(job["json"])
        ip = Path(job["image"]) if job["image"] and Path(job["image"]).exists() else None
        if target == "box":
            self.box.put(jp)
            if ip:
                self.box.put(ip)
        elif target == "webhook":
            parts = [("record", jp.name, jp.read_bytes(), "application/json")]
            if ip:
                parts.append(("image", ip.name, ip.read_bytes(), "image/jpeg"))
            body, ctype = _multipart(parts)
            hdr = {"Authorization": f"Bearer {self.webhook['token']}"} if self.webhook.get("token") else {}
            code, resp = _post(self.webhook["url"], body, ctype, hdr)
            if not 200 <= code < 300:
                raise RuntimeError(f"webhook {code}: {resp[:200]!r}")

    def stop(self):
        self._run = False
        self._wake.set()
