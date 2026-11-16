"""Browser-edited vendors and floor maps, layered over ``data/spotlight_event_maps/``.

Same pattern as ``spotlight_events_admin``: the map files ship with every deploy
and would overwrite edits made on the box, so admin edits live in SQLite and are
merged in at read time (``spotlight_events.floor_map_payload``):

* an uploaded map (document + PNGs) REPLACES the shipped map for that event;
* a vendor override row replaces or adds a vendor by id; ``removed = 1`` drops it;
* an uploaded logo wins over the shipped WebP.

A table belongs to one vendor. Assigning tables (``move`` / ``swap`` / ``save``)
takes them off whoever held them, and the read-time merge enforces the same rule,
so a later file rebuild can't double-book a table an admin assigned.
"""

from __future__ import annotations

import io
import json
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

LOGO_SIZE = 256
CACHE_TTL_SECONDS = 30.0
MAX_TAGS = 12
_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS spotlight_event_vendor_overrides (
    event_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (event_id, vendor_id)
);
CREATE TABLE IF NOT EXISTS spotlight_event_vendor_logos (
    event_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    image BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (event_id, vendor_id)
);
CREATE TABLE IF NOT EXISTS spotlight_event_map_uploads (
    event_id TEXT PRIMARY KEY,
    document_json TEXT NOT NULL,
    image BLOB,
    base_image BLOB,
    updated_at TEXT NOT NULL
);
"""


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Three small tables, created empty; safe at startup."""
    connection.executescript(_SCHEMA)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def version_of(timestamp: str | None) -> int:
    """A cache-busting number for an ISO timestamp (image URLs are cached by URL)."""
    if not timestamp:
        return 0
    try:
        return int(datetime.fromisoformat(timestamp).timestamp())
    except ValueError:
        return 0


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


# -- validation ---------------------------------------------------------------


def validate_vendor(row: object, table_ids: set[str]) -> dict[str, Any]:
    """A clean vendor dict, or ValueError. ``table_ids`` = the map's tables (may be empty)."""
    if not isinstance(row, dict):
        raise ValueError("vendor must be an object")
    name = row.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
        raise ValueError("name is required (80 characters max)")
    vendor_id = row.get("id") or slugify(name)
    if not isinstance(vendor_id, str) or not _ID_RE.match(vendor_id):
        raise ValueError("id must be lowercase letters, digits and dashes")
    tags = row.get("tags") or []
    if not isinstance(tags, list) or len(tags) > MAX_TAGS or not all(
        isinstance(tag, str) and 0 < len(tag.strip()) <= 30 for tag in tags
    ):
        raise ValueError(f"tags must be a list of up to {MAX_TAGS} short strings")
    instagram = row.get("instagram") or None
    if instagram is not None:
        if not isinstance(instagram, str) or len(instagram) > 60:
            raise ValueError("instagram must be a handle")
        instagram = instagram.strip().lstrip("@") or None
    tables = row.get("tableIds") or []
    if not isinstance(tables, list) or not all(isinstance(t, str) for t in tables):
        raise ValueError("tableIds must be a list of table ids")
    unknown = [t for t in tables if t not in table_ids]
    if unknown:
        raise ValueError(f"unknown tables: {', '.join(unknown)}")
    location = row.get("location") or ""
    if not isinstance(location, str) or len(location) > 40:
        raise ValueError("location must be short text")
    return {
        "id": vendor_id,
        "name": name.strip(),
        "location": location.strip(),
        "tableIds": list(dict.fromkeys(tables)),
        "tags": [tag.strip() for tag in tags],
        "instagram": instagram,
    }


def validate_map_document(document: object) -> dict[str, Any]:
    """The builder's map JSON (tools/build_event_floor_map.py), or ValueError."""
    if not isinstance(document, dict):
        raise ValueError("map must be a JSON object")
    tables = document.get("tables")
    vendors = document.get("vendors")
    if not isinstance(tables, list) or not isinstance(vendors, list):
        raise ValueError("map needs `tables` and `vendors` lists")
    table_ids: set[str] = set()
    for table in tables:
        if not isinstance(table, dict) or not isinstance(table.get("id"), str):
            raise ValueError("every table needs a string id")
        for key in ("x", "y", "width", "height"):
            if not isinstance(table.get(key), (int, float)):
                raise ValueError(f"table {table['id']} is missing {key}")
        table_ids.add(table["id"])
    clean_vendors = []
    for vendor in vendors:
        try:
            clean = validate_vendor(vendor, table_ids)
        except ValueError as error:
            name = vendor.get("name") if isinstance(vendor, dict) else vendor
            raise ValueError(f"vendor {name!r}: {error}") from error
        if tables and clean["tableIds"] and not clean["location"]:
            clean["location"] = format_location(clean["tableIds"], tables)
        clean_vendors.append({**vendor, **clean})
    stored = {k: v for k, v in document.items() if k != "imageFile"}
    stored["vendors"] = clean_vendors
    return stored


# -- merge --------------------------------------------------------------------


def format_location(table_ids: list[str], tables: list[dict[str, Any]]) -> str:
    """"K13-K14", "A1-A3, B7": consecutive tables in a block collapse to a range."""
    by_id = {t["id"]: t for t in tables if isinstance(t, dict)}
    numbered = []
    loose = []
    for table_id in table_ids:
        table = by_id.get(table_id)
        if table and isinstance(table.get("block"), str) and isinstance(table.get("number"), int):
            numbered.append((table["block"], table["number"], table_id))
        else:
            loose.append(table_id)
    numbered.sort()
    parts: list[str] = []
    run: list[tuple[str, int, str]] = []
    for item in numbered:
        if run and (item[0] != run[-1][0] or item[1] != run[-1][1] + 1):
            parts.append(run[0][2] if len(run) == 1 else f"{run[0][2]}-{run[-1][2]}")
            run = []
        run.append(item)
    if run:
        parts.append(run[0][2] if len(run) == 1 else f"{run[0][2]}-{run[-1][2]}")
    return ", ".join(parts + loose)


def merge_vendors(
    vendors: list[dict[str, Any]], overrides: dict[str, dict[str, Any]], tables: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Apply override rows to the document's vendors (order kept, additions last)."""
    order = [v["id"] for v in vendors if isinstance(v, dict) and isinstance(v.get("id"), str)]
    by_id = {v["id"]: dict(v) for v in vendors if isinstance(v, dict) and isinstance(v.get("id"), str)}
    admin_tables: set[str] = set()
    for vendor_id, row in overrides.items():
        if row["removed"]:
            by_id.pop(vendor_id, None)
            continue
        payload = row["payload"]
        if not isinstance(payload, dict) or not payload.get("name"):
            continue
        by_id[vendor_id] = {**by_id.get(vendor_id, {}), **payload, "id": vendor_id}
        admin_tables.update(payload.get("tableIds") or [])
        if vendor_id not in order:
            order.append(vendor_id)
    table_ids = {t["id"] for t in tables if isinstance(t, dict)}
    merged = []
    for vendor_id in order:
        vendor = by_id.get(vendor_id)
        if vendor is None:
            continue
        held = [t for t in vendor.get("tableIds") or [] if not table_ids or t in table_ids]
        if vendor_id not in overrides:
            # An admin assignment wins over a shipped vendor still holding the table.
            held = [t for t in held if t not in admin_tables]
        vendor["tableIds"] = held
        if tables and (held or vendor_id in overrides):
            vendor["location"] = format_location(held, tables)
        merged.append(vendor)
    return merged


# -- storage ------------------------------------------------------------------


class VendorsAdmin:
    """Reads/writes the override tables through short-lived connections, so
    request threads never share a sqlite handle."""

    def __init__(self, connect: Callable[[], sqlite3.Connection]) -> None:
        self._connect = connect
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def state(self, event_id: str) -> dict[str, Any]:
        """{"map": {...} | None, "overrides": {vendor id: row}, "logos": {vendor id: updated_at}}."""
        with self._lock:
            cached = self._cache.get(event_id)
            if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
                return cached[1]
        connection = self._connect()
        try:
            overrides = {
                r[0]: {"payload": json.loads(r[1]), "removed": bool(r[2]), "updated_at": r[3]}
                for r in connection.execute(
                    "SELECT vendor_id, payload_json, removed, updated_at FROM spotlight_event_vendor_overrides"
                    " WHERE event_id = ?",
                    (event_id,),
                )
            }
            logos = {
                r[0]: r[1]
                for r in connection.execute(
                    "SELECT vendor_id, updated_at FROM spotlight_event_vendor_logos WHERE event_id = ?", (event_id,)
                )
            }
            row = connection.execute(
                "SELECT document_json, image IS NOT NULL, base_image IS NOT NULL, updated_at"
                " FROM spotlight_event_map_uploads WHERE event_id = ?",
                (event_id,),
            ).fetchone()
        finally:
            connection.close()
        uploaded = (
            {"document": json.loads(row[0]), "has_image": bool(row[1]), "has_base": bool(row[2]), "updated_at": row[3]}
            if row
            else None
        )
        state = {"map": uploaded, "overrides": overrides, "logos": logos}
        with self._lock:
            self._cache[event_id] = (time.monotonic(), state)
        return state

    def map_image(self, event_id: str, kind: str) -> bytes | None:
        column = "base_image" if kind == "base" else "image"
        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT {column} FROM spotlight_event_map_uploads WHERE event_id = ?", (event_id,)
            ).fetchone()
        finally:
            connection.close()
        return bytes(row[0]) if row and row[0] is not None else None

    def logo(self, event_id: str, vendor_id: str) -> bytes | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT image FROM spotlight_event_vendor_logos WHERE event_id = ? AND vendor_id = ?",
                (event_id, vendor_id),
            ).fetchone()
        finally:
            connection.close()
        return bytes(row[0]) if row else None

    # -- writes ---------------------------------------------------------------

    def _write(self, event_id: str, statements: list[tuple[str, tuple[Any, ...]]]) -> None:
        connection = self._connect()
        try:
            for sql, params in statements:
                connection.execute(sql, params)
            connection.commit()
        finally:
            connection.close()
        with self._lock:
            self._cache.pop(event_id, None)

    @staticmethod
    def _upsert(event_id: str, vendor: dict[str, Any], removed: bool = False) -> tuple[str, tuple[Any, ...]]:
        payload = {k: v for k, v in vendor.items() if k != "logoUrl"}
        return (
            """
            INSERT INTO spotlight_event_vendor_overrides (event_id, vendor_id, payload_json, removed, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(event_id, vendor_id) DO UPDATE SET payload_json = excluded.payload_json,
                removed = excluded.removed, updated_at = excluded.updated_at
            """,
            (event_id, vendor["id"], json.dumps(payload, ensure_ascii=False), 1 if removed else 0, _now()),
        )

    def assign(
        self,
        event_id: str,
        current: list[dict[str, Any]],
        tables: list[dict[str, Any]],
        vendor: dict[str, Any],
    ) -> dict[str, Any]:
        """Store ``vendor`` (validated), taking its tables off anyone else who held them."""
        table_ids = {t["id"] for t in tables if isinstance(t, dict)}
        clean = validate_vendor(vendor, table_ids)
        if tables:
            clean["location"] = format_location(clean["tableIds"], tables)
        taken = set(clean["tableIds"])
        statements = []
        for other in current:
            if other["id"] == clean["id"]:
                continue
            kept = [t for t in other.get("tableIds") or [] if t not in taken]
            if len(kept) != len(other.get("tableIds") or []):
                freed = {**other, "tableIds": kept, "location": format_location(kept, tables)}
                statements.append(self._upsert(event_id, freed))
        statements.append(self._upsert(event_id, clean))
        self._write(event_id, statements)
        return clean

    def swap(
        self, event_id: str, current: list[dict[str, Any]], tables: list[dict[str, Any]], a_id: str, b_id: str
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        by_id = {v["id"]: v for v in current}
        if a_id not in by_id or b_id not in by_id or a_id == b_id:
            raise ValueError("swap needs two different vendors on this map")
        a, b = by_id[a_id], by_id[b_id]
        new_a = {**a, "tableIds": list(b.get("tableIds") or []), "location": b.get("location") or ""}
        new_b = {**b, "tableIds": list(a.get("tableIds") or []), "location": a.get("location") or ""}
        if tables:
            new_a["location"] = format_location(new_a["tableIds"], tables)
            new_b["location"] = format_location(new_b["tableIds"], tables)
        self._write(event_id, [self._upsert(event_id, new_a), self._upsert(event_id, new_b)])
        return new_a, new_b

    def remove(self, event_id: str, vendor: dict[str, Any]) -> None:
        self._write(event_id, [self._upsert(event_id, vendor, removed=True)])

    def restore(self, event_id: str, vendor_id: str) -> None:
        """Drop the override and uploaded logo: back to the shipped vendor (or gone, if admin-added)."""
        self._write(
            event_id,
            [
                ("DELETE FROM spotlight_event_vendor_overrides WHERE event_id = ? AND vendor_id = ?", (event_id, vendor_id)),
                ("DELETE FROM spotlight_event_vendor_logos WHERE event_id = ? AND vendor_id = ?", (event_id, vendor_id)),
            ],
        )

    def save_logo(self, event_id: str, vendor_id: str, data: bytes) -> int:
        """Any common image → a centred square 256px WebP (same as the shipped logos)."""
        from PIL import Image  # VM requirement; imported lazily so tests without it still load.

        try:
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                rgba = image.convert("RGBA")
        except Exception as error:  # noqa: BLE001 - any decode failure is a bad upload
            raise ValueError("not a readable image") from error
        side = min(rgba.width, rgba.height)
        left, top = (rgba.width - side) // 2, (rgba.height - side) // 2
        square = rgba.crop((left, top, left + side, top + side)).resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS)
        out = io.BytesIO()
        square.save(out, format="WEBP", quality=88)
        encoded = out.getvalue()
        self._write(
            event_id,
            [
                (
                    """
                    INSERT INTO spotlight_event_vendor_logos (event_id, vendor_id, image, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(event_id, vendor_id) DO UPDATE SET image = excluded.image,
                        updated_at = excluded.updated_at
                    """,
                    (event_id, vendor_id, encoded, _now()),
                )
            ],
        )
        return len(encoded)

    def save_map_document(self, event_id: str, document: object) -> dict[str, Any]:
        """Replace the event's map with an uploaded one. Images upload separately and
        survive a document re-upload (the layout changes more often than the art)."""
        clean = validate_map_document(document)
        clean["eventId"] = event_id
        self._write(
            event_id,
            [
                (
                    """
                    INSERT INTO spotlight_event_map_uploads (event_id, document_json, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(event_id) DO UPDATE SET document_json = excluded.document_json,
                        updated_at = excluded.updated_at
                    """,
                    (event_id, json.dumps(clean, ensure_ascii=False), _now()),
                )
            ],
        )
        return clean

    def save_map_image(self, event_id: str, kind: str, data: bytes) -> int:
        """Store a PNG (anything PIL reads is converted). Needs an uploaded document first."""
        from PIL import Image

        try:
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                if image.format == "PNG":
                    encoded = data
                else:
                    out = io.BytesIO()
                    image.convert("RGBA").save(out, format="PNG", optimize=True)
                    encoded = out.getvalue()
        except Exception as error:  # noqa: BLE001
            raise ValueError("not a readable image") from error
        if self.state(event_id)["map"] is None:
            raise ValueError("upload the map JSON first")
        column = "base_image" if kind == "base" else "image"
        self._write(
            event_id,
            [(f"UPDATE spotlight_event_map_uploads SET {column} = ?, updated_at = ? WHERE event_id = ?",
              (encoded, _now(), event_id))],
        )
        return len(encoded)

    def reset_map(self, event_id: str) -> None:
        self._write(event_id, [("DELETE FROM spotlight_event_map_uploads WHERE event_id = ?", (event_id,))])
