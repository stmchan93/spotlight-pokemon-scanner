"""Booth claims admin + post-show recaps (docs/booth-posts-vendor-spec-2026-10-29.md).

Claims, booth events and notifications live in Supabase (social_27), so every
call here is PostgREST with the service-role key, the same credentials the
moderation worker uses. The backend keeps owning the vendor list (the floor
maps), which is how the admin page scopes claims to a show.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import spotlight_events

HTTP_TIMEOUT = 20


class BoothAdminError(RuntimeError):
    pass


def _env() -> tuple[str, str]:
    url = str(
        os.environ.get("SUPABASE_URL")
        or os.environ.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL")
        or os.environ.get("SPOTLIGHT_SUPABASE_URL")
        or ""
    ).strip().rstrip("/")
    key = str(
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY") or ""
    ).strip()
    return url, key


def configured() -> bool:
    url, key = _env()
    return bool(url and key)


def _rest(method: str, path: str, body: Any = None, *, prefer: str | None = None) -> Any:
    """One PostgREST call; raises BoothAdminError with the server's message."""
    url, key = _env()
    if not url or not key:
        raise BoothAdminError("supabase_not_configured")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(f"{url}/rest/v1/{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            raw = response.read()
    except HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise BoothAdminError(f"supabase {error.code}: {detail}") from error
    except OSError as error:
        raise BoothAdminError(f"supabase unreachable: {error}") from error
    return json.loads(raw) if raw else None


def _map_vendors(event_id: str) -> dict[str, str] | None:
    """{vendor id: name} from the show's floor map, or None when it has no map."""
    document = spotlight_events.floor_map_payload(event_id)
    if document is None:
        return None
    return {
        str(vendor.get("id")): str(vendor.get("name") or vendor.get("id"))
        for vendor in document.get("vendors") or []
        if isinstance(vendor, dict) and vendor.get("id")
    }


def booth_overview(event_id: str) -> list[dict[str, Any]]:
    """Active claims on this show's vendors with their totals at this show.

    Claims are keyed by vendor slug across shows, so the RPC returns every
    claim; this keeps the ones on the show's map (or, without a map, the ones
    made at this show).
    """
    rows = _rest("POST", "rpc/booth_admin_overview", {"p_event_id": event_id}) or []
    vendors = _map_vendors(event_id)
    result = []
    for row in rows:
        vendor_id = str(row.get("vendor_id") or "")
        if vendors is not None:
            if vendor_id not in vendors:
                continue
        elif row.get("event_id") != event_id:
            continue
        result.append(
            {
                "vendorId": vendor_id,
                "vendorName": (vendors or {}).get(vendor_id, vendor_id),
                "userId": row.get("user_id"),
                "handle": row.get("handle"),
                "claimedAt": row.get("claimed_at"),
                "claimedAtEvent": row.get("event_id"),
                "reports": int(row.get("report_count") or 0),
                "views": int(row.get("card_opens") or 0),
                "instagramTaps": int(row.get("instagram_taps") or 0),
                "messages": int(row.get("message_starts") or 0),
                "postViews": int(row.get("post_views") or 0),
                "posts": int(row.get("post_count") or 0),
            }
        )
    result.sort(key=lambda item: (-item["reports"], item["vendorName"].lower()))
    return result


def unclaim(vendor_id: str) -> int:
    """Revoke the active claim on a vendor. Returns rows revoked (0 or 1)."""
    rows = _rest(
        "PATCH",
        f"booth_claims?vendor_id=eq.{quote(vendor_id, safe='')}&revoked_at=is.null",
        {"revoked_at": datetime.now(timezone.utc).isoformat()},
        prefer="return=representation",
    )
    return len(rows or [])


def event_name(event: dict[str, Any]) -> str:
    return str(event.get("shortTitle") or event.get("title") or event.get("id"))


def send_recaps(event_id: str, name: str) -> int:
    """Run send_booth_recaps; the SQL dedupes per claimer + show, so re-runs send nothing new."""
    sent = _rest("POST", "rpc/send_booth_recaps", {"p_event_id": event_id, "p_event_name": name})
    return int(sent or 0)


# Yesterday is the target; two more days back cover missed cron ticks, and the
# SQL dedupe makes the repeat sends no-ops.
RECAP_LOOKBACK_DAYS = 3


def events_ended_yesterday(events: list[dict[str, Any]], now: datetime | None = None) -> list[dict[str, Any]]:
    """Shows whose last day was yesterday (up to RECAP_LOOKBACK_DAYS ago) in their own timezone."""
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    due = []
    for event in events:
        try:
            zone = ZoneInfo(str(event.get("timezone") or "UTC"))
        except (ZoneInfoNotFoundError, ValueError):
            zone = ZoneInfo("UTC")
        today = moment.astimezone(zone).date()
        window = {(today - timedelta(days=days)).isoformat() for days in range(1, RECAP_LOOKBACK_DAYS + 1)}
        if event.get("endDate") in window:
            due.append(event)
    return due


def recap_due_events(now: datetime | None = None) -> list[dict[str, Any]]:
    return events_ended_yesterday(spotlight_events.load_events(include_hidden=True), now)


__all__ = [
    "BoothAdminError",
    "booth_overview",
    "configured",
    "event_name",
    "events_ended_yesterday",
    "recap_due_events",
    "send_recaps",
    "unclaim",
]
