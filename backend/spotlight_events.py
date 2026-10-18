"""Spotlight's own card shows for the mobile Events tab.

Hand-maintained in ``backend/data/spotlight_events.json`` (``{"events": [...]}``);
flyer images sit next to it in ``backend/data/spotlight_event_flyers/``. Rows that
fail validation are skipped and logged, never served; a duplicate id keeps the
first row.

Served shape: ``{"items": [SpotlightEvent, ...]}`` ordered live, then upcoming
(soonest first), then past (most recent first). ``status`` is computed from
today's date in each event's own timezone. The raw ``flyer`` filename never goes
on the wire; ``flyerUrl`` is the flyer route when the file exists, else null.
``floorMapUrl`` likewise points at the event's floor map
(``data/spotlight_event_maps/<id>.json`` + image) when one has been built.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LOGGER = logging.getLogger("spotlight.spotlight_events")

DATA_DIR = Path(__file__).resolve().parent / "data"
EVENTS_PATH = DATA_DIR / "spotlight_events.json"
FLYERS_DIR = DATA_DIR / "spotlight_event_flyers"
# `<event-id>.json` + its floor image, written by tools/build_event_floor_map.py.
MAPS_DIR = DATA_DIR / "spotlight_event_maps"
FLYER_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
STATUSES = ("live", "upcoming", "past")

_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
# A bare filename only: no separators, no leading dot.
_FLYER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


class _Invalid(ValueError):
    pass


def _required_str(row: dict[str, Any], field: str) -> str:
    value = row.get(field)
    text = value.strip() if isinstance(value, str) else ""
    if not text:
        raise _Invalid(f"missing {field}")
    return text


def _optional_str(row: dict[str, Any], field: str) -> str | None:
    value = row.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _Invalid(f"{field} must be a string or null")
    return value.strip() or None


def _date(row: dict[str, Any], field: str) -> date:
    value = row.get(field)
    if not isinstance(value, str) or not _DATE_RE.match(value):
        raise _Invalid(f"{field} must be YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise _Invalid(f"{field} is not a real date") from error


def _time(row: dict[str, Any], field: str) -> str | None:
    value = row.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not _TIME_RE.match(value):
        raise _Invalid(f"{field} must be HH:MM (24h) or null")
    return value


def _coordinate(row: dict[str, Any], field: str, bound: float) -> float | None:
    value = row.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not -bound <= value <= bound:
        raise _Invalid(f"{field} must be a number in [-{bound:g}, {bound:g}] or null")
    return float(value)


def _https_url(row: dict[str, Any], field: str) -> str | None:
    value = _optional_str(row, field)
    if value is None:
        return None
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise _Invalid(f"{field} must be an https URL or null")
    return value


def _pricing(row: dict[str, Any]) -> dict[str, Any] | None:
    """Optional ticket pricing copy; ``general`` is the only required line."""
    value = row.get("pricing")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise _Invalid("pricing must be an object or null")
    notes = value.get("notes", [])
    if notes is None:
        notes = []
    if not isinstance(notes, list) or not all(isinstance(n, str) and n.strip() for n in notes):
        raise _Invalid("pricing.notes must be a list of non-empty strings")
    return {
        "general": _required_str(value, "general"),
        "doorPrice": _optional_str(value, "doorPrice"),
        "notes": [n.strip() for n in notes],
        "disclaimer": _optional_str(value, "disclaimer"),
    }


def _validate_event(row: object) -> dict[str, Any]:
    """One JSON row -> stored event (still carrying ``flyer``); raises _Invalid."""
    if not isinstance(row, dict):
        raise _Invalid("not an object")
    event_id = row.get("id")
    if not isinstance(event_id, str) or not _ID_RE.match(event_id):
        raise _Invalid("id must be a [a-z0-9-] slug")
    title = _required_str(row, "title")
    start, end = _date(row, "startDate"), _date(row, "endDate")
    if end < start:
        raise _Invalid("endDate is before startDate")
    tz_name = _required_str(row, "timezone")
    try:
        ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise _Invalid(f"unknown timezone {tz_name!r}") from error
    latitude = _coordinate(row, "latitude", 90)
    longitude = _coordinate(row, "longitude", 180)
    if (latitude is None) != (longitude is None):
        raise _Invalid("latitude and longitude must both be set or both null")
    table_count = row.get("tableCount")
    if table_count is not None and (
        isinstance(table_count, bool) or not isinstance(table_count, int) or table_count < 0
    ):
        raise _Invalid("tableCount must be a non-negative int or null")
    categories = row.get("categories", [])
    if categories is None:
        categories = []
    if not isinstance(categories, list) or not all(isinstance(c, str) and c.strip() for c in categories):
        raise _Invalid("categories must be a list of non-empty strings")
    flyer = _optional_str(row, "flyer")
    if flyer is not None and (
        not _FLYER_RE.match(flyer) or Path(flyer).suffix.lower() not in FLYER_CONTENT_TYPES
    ):
        raise _Invalid("flyer must be a bare .png/.jpg/.webp filename or null")
    featured = row.get("featured", False)
    if not isinstance(featured, bool):
        raise _Invalid("featured must be a bool")
    accent = _optional_str(row, "accentColor")
    if accent is not None and not _COLOR_RE.match(accent):
        raise _Invalid("accentColor must be #RRGGBB or null")
    return {
        "id": event_id,
        "title": title,
        "shortTitle": _optional_str(row, "shortTitle") or title,
        "venue": _required_str(row, "venue"),
        "city": _required_str(row, "city"),
        "address": _required_str(row, "address"),
        "latitude": latitude,
        "longitude": longitude,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "timezone": tz_name,
        "openTime": _time(row, "openTime"),
        "closeTime": _time(row, "closeTime"),
        "tableCount": table_count,
        "categories": [c.strip() for c in categories],
        "about": _optional_str(row, "about"),
        "pricing": _pricing(row),
        "flyer": flyer,
        "ticketUrl": _https_url(row, "ticketUrl"),
        "shareUrl": _https_url(row, "shareUrl"),
        "featured": featured,
        "accentColor": accent.upper() if accent else None,
    }


def load_events(path: Path | None = None) -> list[dict[str, Any]]:
    """Validated events; re-read whenever the file's mtime changes."""
    target = Path(path or EVENTS_PATH)
    try:
        mtime = target.stat().st_mtime
    except OSError:
        return []
    key = str(target)
    with _lock:
        cached = _cache.get(key)
        if cached and cached[0] == mtime:
            return [dict(e) for e in cached[1]]
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        LOGGER.warning("spotlight events file %s unreadable: %s", target, error)
        return []
    rows = raw.get("events") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        LOGGER.warning("spotlight events file %s has no events list", target)
        rows = []
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        try:
            event = _validate_event(row)
            if event["id"] in seen:
                raise _Invalid(f"duplicate id {event['id']!r}")
        except _Invalid as error:
            LOGGER.warning("spotlight event #%d skipped: %s", index, error)
            continue
        seen.add(event["id"])
        events.append(event)
    with _lock:
        _cache[key] = (mtime, events)
    return [dict(e) for e in events]


def event_status(event: dict[str, Any], now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    today = moment.astimezone(ZoneInfo(event["timezone"])).date().isoformat()
    if today < event["startDate"]:
        return "upcoming"
    if today > event["endDate"]:
        return "past"
    return "live"


def _flyer_path(event: dict[str, Any], flyers_dir: Path) -> Path | None:
    name = event.get("flyer")
    if not name:
        return None
    root = flyers_dir.resolve()
    candidate = (root / name).resolve()
    # Belt and braces on top of the filename regex.
    if candidate.parent != root or not candidate.is_file():
        return None
    return candidate


def flyer_url(event_id: str) -> str:
    return f"/api/v1/events/{event_id}/flyer"


def build_events_payload(
    *,
    now: datetime | None = None,
    events_path: Path | None = None,
    flyers_dir: Path | None = None,
    maps_dir: Path | None = None,
) -> dict[str, Any]:
    flyers = Path(flyers_dir or FLYERS_DIR)
    maps = Path(maps_dir or MAPS_DIR)
    buckets: dict[str, list[dict[str, Any]]] = {status: [] for status in STATUSES}
    for event in load_events(events_path):
        has_flyer = _flyer_path(event, flyers) is not None
        item = {k: v for k, v in event.items() if k != "flyer"}
        item["flyerUrl"] = flyer_url(event["id"]) if has_flyer else None
        item["floorMapUrl"] = floor_map_url(event["id"]) if _load_map(event["id"], maps) else None
        item["status"] = event_status(event, now)
        buckets[item["status"]].append(item)
    buckets["live"].sort(key=lambda e: (e["startDate"], e["id"]))
    buckets["upcoming"].sort(key=lambda e: (e["startDate"], e["id"]))
    buckets["past"].sort(key=lambda e: (e["startDate"], e["id"]), reverse=True)
    return {"items": buckets["live"] + buckets["upcoming"] + buckets["past"]}


def flyer_file(
    event_id: str, *, events_path: Path | None = None, flyers_dir: Path | None = None
) -> tuple[Path, str] | None:
    """(path, content type) for a validated event's flyer, else None.

    Only the filename named in validated metadata is ever served.
    """
    event = next((e for e in load_events(events_path) if e["id"] == event_id), None)
    if event is None:
        return None
    path = _flyer_path(event, Path(flyers_dir or FLYERS_DIR))
    if path is None:
        return None
    return path, FLYER_CONTENT_TYPES[path.suffix.lower()]


def floor_map_url(event_id: str) -> str:
    return f"/api/v1/events/{event_id}/map"


def floor_map_image_url(event_id: str) -> str:
    return f"/api/v1/events/{event_id}/map-image"


def floor_map_base_image_url(event_id: str) -> str:
    return f"/api/v1/events/{event_id}/map-base-image"


def _vector_base_name(document: dict[str, Any]) -> str | None:
    vector = document.get("vector")
    name = vector.get("baseImageFile") if isinstance(vector, dict) else None
    return name if isinstance(name, str) else None


def _map_image_path(document: dict[str, Any], maps_dir: Path, name: str | None = None) -> Path | None:
    name = document.get("imageFile") if name is None else name
    if not isinstance(name, str) or not _FLYER_RE.match(name) or Path(name).suffix.lower() != ".png":
        return None
    root = maps_dir.resolve()
    candidate = (root / name).resolve()
    if candidate.parent != root or not candidate.is_file():
        return None
    return candidate


def _load_map(event_id: str, maps_dir: Path) -> dict[str, Any] | None:
    """The stored map document, only when it AND its image are present."""
    if not _ID_RE.match(event_id):
        return None
    path = maps_dir / f"{event_id}.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    key = f"map:{path}"
    with _lock:
        cached = _cache.get(key)
        if cached and cached[0] == mtime:
            document = cached[1][0]
            return document if _map_image_path(document, maps_dir) else None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        LOGGER.warning("floor map %s unreadable: %s", path, error)
        return None
    if not isinstance(document, dict) or not isinstance(document.get("tables"), list) or not isinstance(
        document.get("vendors"), list
    ):
        LOGGER.warning("floor map %s has no tables/vendors", path)
        return None
    with _lock:
        _cache[key] = (mtime, [document])
    return document if _map_image_path(document, maps_dir) else None


def floor_map_payload(
    event_id: str, *, events_path: Path | None = None, maps_dir: Path | None = None
) -> dict[str, Any] | None:
    """The served map for a validated event, or None. The image filename never goes on the wire."""
    if not any(e["id"] == event_id for e in load_events(events_path)):
        return None
    document = _load_map(event_id, Path(maps_dir or MAPS_DIR))
    if document is None:
        return None
    payload = {k: v for k, v in document.items() if k != "imageFile"}
    payload["eventId"] = event_id
    logos = _logos_dir(event_id, Path(maps_dir or MAPS_DIR))
    payload["vendors"] = [{**vendor, "logoUrl": _vendor_logo_url(event_id, vendor, logos)} for vendor in document["vendors"]]
    payload["imageUrl"] = floor_map_image_url(event_id)
    # The app draws tables/labels itself over a walls-only image; without that
    # image it falls back to the flat `imageUrl`.
    vector = document.get("vector")
    base_name = _vector_base_name(document)
    if isinstance(vector, dict) and base_name and _map_image_path(document, Path(maps_dir or MAPS_DIR), base_name):
        served = {k: v for k, v in vector.items() if k != "baseImageFile"}
        served["baseImageUrl"] = floor_map_base_image_url(event_id)
        payload["vector"] = served
    else:
        payload["vector"] = None
    return payload


def floor_map_image_file(
    event_id: str, *, events_path: Path | None = None, maps_dir: Path | None = None
) -> Path | None:
    if not any(e["id"] == event_id for e in load_events(events_path)):
        return None
    maps = Path(maps_dir or MAPS_DIR)
    document = _load_map(event_id, maps)
    return _map_image_path(document, maps) if document else None


def floor_map_base_image_file(
    event_id: str, *, events_path: Path | None = None, maps_dir: Path | None = None
) -> Path | None:
    if not any(e["id"] == event_id for e in load_events(events_path)):
        return None
    maps = Path(maps_dir or MAPS_DIR)
    document = _load_map(event_id, maps)
    base_name = _vector_base_name(document) if document else None
    return _map_image_path(document, maps, base_name) if document and base_name else None


def _logos_dir(event_id: str, maps_dir: Path) -> Path:
    """Square WebP logos keyed by vendor id (tools/build_event_vendor_logos.py), kept apart
    from the map JSON so a Figma rebuild doesn't drop them."""
    return maps_dir / f"{event_id}-logos"


def _vendor_logo_path(logos: Path, vendor_id: object) -> Path | None:
    if not isinstance(vendor_id, str) or not _ID_RE.match(vendor_id):
        return None
    path = logos / f"{vendor_id}.webp"
    return path if path.is_file() else None


def _vendor_logo_url(event_id: str, vendor: Any, logos: Path) -> str | None:
    path = _vendor_logo_path(logos, vendor.get("id") if isinstance(vendor, dict) else None)
    if path is None:
        return None
    # Served with a long cache; the mtime busts it when a vendor sends a new logo.
    return f"/api/v1/events/{event_id}/vendor-logos/{vendor['id']}?v={int(path.stat().st_mtime)}"


def floor_map_vendor_logo_file(
    event_id: str, vendor_id: str, *, events_path: Path | None = None, maps_dir: Path | None = None
) -> Path | None:
    if not _ID_RE.match(event_id) or not any(e["id"] == event_id for e in load_events(events_path)):
        return None
    return _vendor_logo_path(_logos_dir(event_id, Path(maps_dir or MAPS_DIR)), vendor_id)


def clear_cache() -> None:
    with _lock:
        _cache.clear()
