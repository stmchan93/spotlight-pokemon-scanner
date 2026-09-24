"""Coming up: upcoming release / ban-list / reveal / event dates per game.

Contract: docs/meta-feed-v2-contracts-2026-09-24.md §2 (CalendarEvent / CalendarFeed).

Two sources, merged, deduped, upcoming only (date >= today), ascending:
- ``expansions`` rows with a future ``release_date`` (automatic, kind ``release``).
- ``backend/data/calendar_events.json``: a small hand-maintained list. Every row
  needs an official/reputable source ``url``; rows that fail validation are
  skipped and logged, never served.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from catalog_tools import SUPPORTED_GAMES

LOGGER = logging.getLogger("spotlight.calendar_feed")

EVENTS_PATH = Path(__file__).resolve().parent / "data" / "calendar_events.json"
KINDS = ("release", "ban_list", "reveal", "event")
DEFAULT_LIMIT = 20
MAX_LIMIT = 100
CACHE_TTL_SECONDS = 3600.0
_CACHE_MAX_ENTRIES = 64
_JAPANESE = {"ja", "jp", "jpn", "japanese"}
_DATE_RE = re.compile(r"^(\d{4})[-/](\d{2})[-/](\d{2})")

_events_lock = threading.Lock()
_events_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_payload_lock = threading.Lock()
_payload_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}


def _parse_date(value: object) -> date | None:
    match = _DATE_RE.match(str(value or "").strip())
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _today(today: date | str | None) -> date:
    if isinstance(today, date):
        return today
    if today:
        parsed = _parse_date(today)
        if parsed is None:
            raise ValueError(f"bad today: {today!r}")
        return parsed
    return datetime.now(timezone.utc).date()


def _optional_str(value: object) -> str | None:
    text = str(value).strip() if isinstance(value, str) else ""
    return text or None


def _validate_event(row: object) -> tuple[dict[str, Any] | None, str | None]:
    """One JSON row -> (CalendarEvent, None) or (None, reason)."""
    if not isinstance(row, dict):
        return None, "not an object"
    event_id = _optional_str(row.get("id"))
    if not event_id:
        return None, "missing id"
    day = _parse_date(row.get("date"))
    if day is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(row.get("date"))):
        return None, "date must be YYYY-MM-DD"
    kind = row.get("kind")
    if kind not in KINDS:
        return None, f"kind must be one of {', '.join(KINDS)}"
    game = row.get("game")
    if game not in SUPPORTED_GAMES:
        return None, f"unknown game {game!r}"
    title = _optional_str(row.get("title"))
    if not title:
        return None, "missing title"
    for field in ("subtitle", "setId"):
        if row.get(field) is not None and not isinstance(row.get(field), str):
            return None, f"{field} must be a string or null"
    url = _optional_str(row.get("url"))
    if not url or not url.startswith(("https://", "http://")):
        return None, "url (the source) must be an http(s) link"
    return {
        "id": event_id,
        "date": day.isoformat(),
        "kind": kind,
        "game": game,
        "title": title,
        "subtitle": _optional_str(row.get("subtitle")),
        "setId": _optional_str(row.get("setId")),
        "url": url,
    }, None


def load_events(path: Path | None = None) -> list[dict[str, Any]]:
    """Validated hand-maintained events; re-read whenever the file changes."""
    target = Path(path or EVENTS_PATH)
    try:
        mtime = target.stat().st_mtime
    except OSError:
        return []
    key = str(target)
    with _events_lock:
        cached = _events_cache.get(key)
        if cached and cached[0] == mtime:
            return list(cached[1])
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        LOGGER.warning("calendar events file %s unreadable: %s", target, error)
        return []
    rows = raw.get("events") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        LOGGER.warning("calendar events file %s has no events list", target)
        rows = []
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        event, reason = _validate_event(row)
        if event is not None and event["id"] in seen:
            event, reason = None, f"duplicate id {event['id']!r}"
        if event is None:
            LOGGER.warning("calendar event #%d skipped: %s", index, reason)
            continue
        seen.add(event["id"])
        events.append(event)
    with _events_lock:
        _events_cache[key] = (mtime, events)
    return list(events)


def _expansion_events(
    connection: sqlite3.Connection, *, game: str | None, today: date
) -> list[dict[str, Any]]:
    # Scrydex dates arrive as YYYY/MM/DD or YYYY-MM-DD; both sort as text once
    # the slashes are normalized.
    sql = (
        "SELECT id, game, name, language, release_date FROM expansions "
        "WHERE release_date IS NOT NULL AND replace(substr(release_date, 1, 10), '/', '-') >= ?"
    )
    params: list[Any] = [today.isoformat()]
    if game:
        sql += " AND +game = ?"
        params.append(game)
    events: list[dict[str, Any]] = []
    for row in connection.execute(sql, params).fetchall():
        set_id, row_game, name, language, release_date = (
            row[0], row[1], row[2], row[3], row[4],
        )
        day = _parse_date(release_date)
        title = str(name or "").strip()
        if day is None or not title or row_game not in SUPPORTED_GAMES:
            continue
        if str(language or "").strip().lower() in _JAPANESE:
            title += " (Japanese)"
        events.append({
            "id": f"release:{set_id}",
            "date": day.isoformat(),
            "kind": "release",
            "game": row_game,
            "title": title,
            "subtitle": "New set",
            "setId": set_id,
            "url": None,
        })
    return events


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _same_event(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a["id"] == b["id"]:
        return True
    if (a["game"], a["kind"], a["date"]) != (b["game"], b["kind"], b["date"]):
        return False
    if a["setId"] and a["setId"] == b["setId"]:
        return True
    # A hand-entered release names the set its own way ("Mega Evolution—Delta
    # Reign" vs the catalog's "Delta Reign"): containment on the same day is one set.
    ta, tb = _norm(a["title"]), _norm(b["title"])
    return bool(ta and tb) and (ta in tb or tb in ta)


def _merge(primary: list[dict[str, Any]], extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = [dict(item) for item in primary]
    for item in extra:
        match = next((kept for kept in merged if _same_event(kept, item)), None)
        if match is None:
            merged.append(dict(item))
            continue
        # The catalog row wins on identity; the hand row lends its source link.
        for field in ("url", "subtitle", "setId"):
            if match.get(field) in (None, "New set") and item.get(field):
                match[field] = item[field]
    return merged


_KIND_ORDER = {kind: i for i, kind in enumerate(KINDS)}


def build_calendar_payload(
    connection: sqlite3.Connection,
    *,
    game: str | None = None,
    limit: int = DEFAULT_LIMIT,
    today: date | str | None = None,
    events_path: Path | None = None,
) -> dict[str, Any]:
    """CalendarFeed: ``{"items": [CalendarEvent, ...]}``, upcoming, ascending."""
    if game is not None and game not in SUPPORTED_GAMES:
        raise ValueError(f"unknown game: {game}")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIMIT}")
    day = _today(today)
    cutoff = day.isoformat()
    hand = [
        e for e in load_events(events_path)
        if e["date"] >= cutoff and (game is None or e["game"] == game)
    ]
    items = _merge(_expansion_events(connection, game=game, today=day), hand)
    items.sort(key=lambda e: (e["date"], _KIND_ORDER[e["kind"]], e["game"], e["title"]))
    return {"items": items[:limit]}


def cached_calendar_payload(
    connection: sqlite3.Connection, *, game: str | None, limit: int
) -> dict[str, Any]:
    """build_calendar_payload behind a ~1h in-process cache (keyed per day)."""
    day = _today(None)
    key = (id(connection), game, limit, day.isoformat())
    now = time.monotonic()
    with _payload_lock:
        cached = _payload_cache.get(key)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]
    payload = build_calendar_payload(connection, game=game, limit=limit, today=day)
    with _payload_lock:
        if len(_payload_cache) >= _CACHE_MAX_ENTRIES:
            oldest = min(_payload_cache, key=lambda k: _payload_cache[k][0])
            _payload_cache.pop(oldest, None)
        _payload_cache[key] = (now, payload)
    return payload


def clear_cache() -> None:
    with _payload_lock:
        _payload_cache.clear()
    with _events_lock:
        _events_cache.clear()
