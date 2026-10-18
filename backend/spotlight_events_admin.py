"""Browser-edited Spotlight shows, layered over ``data/spotlight_events.json``.

The JSON file ships with every deploy and would overwrite edits made on the
box, so admin edits live in SQLite instead and are merged in at read time:

* an override row REPLACES the file's event with the same id, or ADDS a new one;
* ``hidden = 1`` takes an event (file or admin) off the Events tab;
* deleting the override row restores the file version.

Flyers uploaded here are stored in SQLite too (re-encoded to a 720px JPEG), so
they survive deploys and need no writable data directory.
"""

from __future__ import annotations

import io
import json
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import spotlight_events

FLYER_WIDTH = 720
FLYER_JPEG_QUALITY = 85
# Admin edits are rare; a short TTL keeps reads off the database without making
# an edit wait long to show up (writes in this process clear it immediately).
CACHE_TTL_SECONDS = 30.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS spotlight_event_overrides (
    event_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spotlight_event_flyers (
    event_id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    image BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Two tiny tables, created empty; safe at startup."""
    connection.executescript(_SCHEMA)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class EventsAdmin:
    """Reads and writes the override tables through short-lived connections, so
    request threads never share a sqlite handle."""

    def __init__(self, connect: Callable[[], sqlite3.Connection]) -> None:
        self._connect = connect
        self._lock = threading.Lock()
        self._cached: tuple[float, list[dict[str, Any]], dict[str, str]] | None = None

    # -- reads ----------------------------------------------------------------

    def overrides(self) -> tuple[list[dict[str, Any]], dict[str, str]]:
        """(override rows, {event id: uploaded-flyer timestamp}), cached briefly."""
        with self._lock:
            if self._cached and time.monotonic() - self._cached[0] < CACHE_TTL_SECONDS:
                return [dict(row) for row in self._cached[1]], dict(self._cached[2])
        connection = self._connect()
        try:
            rows = [
                {"event_id": r[0], "payload": json.loads(r[1]), "hidden": bool(r[2]), "updated_at": r[3]}
                for r in connection.execute(
                    "SELECT event_id, payload_json, hidden, updated_at FROM spotlight_event_overrides"
                )
            ]
            flyers = {
                r[0]: r[1] for r in connection.execute("SELECT event_id, updated_at FROM spotlight_event_flyers")
            }
        finally:
            connection.close()
        with self._lock:
            self._cached = (time.monotonic(), rows, flyers)
        return [dict(row) for row in rows], dict(flyers)

    def flyer(self, event_id: str) -> tuple[bytes, str] | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT image, content_type FROM spotlight_event_flyers WHERE event_id = ?", (event_id,)
            ).fetchone()
        finally:
            connection.close()
        return (bytes(row[0]), str(row[1])) if row else None

    # -- writes ---------------------------------------------------------------

    def _write(self, sql: str, params: tuple[Any, ...]) -> None:
        connection = self._connect()
        try:
            connection.execute(sql, params)
            connection.commit()
        finally:
            connection.close()
        with self._lock:
            self._cached = None

    def save_event(self, row: object) -> dict[str, Any]:
        """Validate exactly as the file is validated, then store. Raises ValueError."""
        try:
            event = spotlight_events.validate_event(row)
        except spotlight_events.InvalidEvent as error:
            raise ValueError(str(error)) from error
        stored = dict(row) if isinstance(row, dict) else {}
        # Flyers come from the upload slot or the shipped file, never a typed path.
        stored.pop("flyer", None)
        self._write(
            """
            INSERT INTO spotlight_event_overrides (event_id, payload_json, hidden, updated_at)
            VALUES (?, ?, 0, ?)
            ON CONFLICT(event_id) DO UPDATE SET payload_json = excluded.payload_json,
                                                updated_at = excluded.updated_at
            """,
            (event["id"], json.dumps(stored, ensure_ascii=False), _now()),
        )
        return event

    def set_hidden(self, event_id: str, hidden: bool) -> None:
        """Hide/unhide. For a file-only event the row carries no payload, so the
        file version (and later edits to it) still applies once it is shown again."""
        payload = json.dumps({"id": event_id}, ensure_ascii=False)
        self._write(
            """
            INSERT INTO spotlight_event_overrides (event_id, payload_json, hidden, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at
            """,
            (event_id, payload, 1 if hidden else 0, _now()),
        )

    def reset(self, event_id: str) -> None:
        """Drop the override (and its uploaded flyer): back to the shipped file."""
        self._write("DELETE FROM spotlight_event_overrides WHERE event_id = ?", (event_id,))
        self._write("DELETE FROM spotlight_event_flyers WHERE event_id = ?", (event_id,))

    def save_flyer(self, event_id: str, data: bytes) -> int:
        """Re-encode any common image to a 720px-wide JPEG. Returns stored bytes."""
        from PIL import Image  # VM requirement; imported lazily so tests without it still load.

        try:
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                rgb = image.convert("RGB")
        except Exception as error:  # noqa: BLE001 - any decode failure is a bad upload
            raise ValueError("not a readable image") from error
        if rgb.width > FLYER_WIDTH:
            height = round(rgb.height * FLYER_WIDTH / rgb.width)
            rgb = rgb.resize((FLYER_WIDTH, height), Image.LANCZOS)
        out = io.BytesIO()
        rgb.save(out, format="JPEG", quality=FLYER_JPEG_QUALITY, optimize=True, progressive=True)
        encoded = out.getvalue()
        self._write(
            """
            INSERT INTO spotlight_event_flyers (event_id, content_type, image, updated_at)
            VALUES (?, 'image/jpeg', ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET content_type = excluded.content_type,
                                                image = excluded.image, updated_at = excluded.updated_at
            """,
            (event_id, encoded, _now()),
        )
        return len(encoded)


def admin_page() -> str:
    return (Path(__file__).resolve().parent / "admin" / "events.html").read_text(encoding="utf-8")
