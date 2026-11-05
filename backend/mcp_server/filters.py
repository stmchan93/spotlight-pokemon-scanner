"""CardFilter validation shared by every tool that takes a filter."""

from __future__ import annotations

import base64
import json
from typing import Any

from catalog_tools import RARITY_BUCKET_KEYS


class ToolInputError(ValueError):
    """A caller mistake; the message is shown to the AI verbatim."""


# Fields only art_search can answer. `pokemon` is here because it means "who is
# in the artwork" (incl. cameos), not the card name — use `text` for names.
ART_FILTER_FIELDS = (
    "pokemon",
    "pokemon_role",
    "scene",
    "weather_time",
    "activity",
    "mood",
    "art_style",
    "palette",
    "theme",
)
LIST_FIELDS = (
    "pokemon",
    "scene",
    "weather_time",
    "activity",
    "mood",
    "art_style",
    "palette",
    "rarity_bucket",
)
STRING_FIELDS = ("text", "artist", "theme", "set")
POKEMON_ROLES = ("any", "main", "background_or_cameo")
LANGUAGES = ("English", "Japanese", "any")
ALL_FIELDS = (
    *STRING_FIELDS,
    *LIST_FIELDS,
    "pokemon_role",
    "language",
    "price_min_usd",
    "price_max_usd",
)

MAX_LIST_ITEMS = 10
MAX_STRING_LENGTH = 120


def normalize_card_filter(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Drop empties, validate enums/types, cap sizes. Returns a clean dict."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ToolInputError("filter must be an object.")
    unknown = sorted(set(raw) - set(ALL_FIELDS))
    if unknown:
        raise ToolInputError(f"Unknown filter field(s): {', '.join(unknown)}.")

    clean: dict[str, Any] = {}
    for field in STRING_FIELDS:
        value = raw.get(field)
        if value is None:
            continue
        text = str(value).strip()
        if len(text) > MAX_STRING_LENGTH:
            raise ToolInputError(f"filter.{field} is too long (max {MAX_STRING_LENGTH} characters).")
        if text:
            clean[field] = text

    for field in LIST_FIELDS:
        value = raw.get(field)
        if value is None:
            continue
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, (list, tuple)):
            raise ToolInputError(f"filter.{field} must be a list of strings.")
        items = [str(item).strip() for item in value if str(item or "").strip()]
        if len(items) > MAX_LIST_ITEMS:
            raise ToolInputError(f"filter.{field} accepts at most {MAX_LIST_ITEMS} values.")
        if any(len(item) > MAX_STRING_LENGTH for item in items):
            raise ToolInputError(f"filter.{field} has a value that is too long.")
        if field == "rarity_bucket":
            items = [item.lower() for item in items]
            bad = [item for item in items if item not in RARITY_BUCKET_KEYS]
            if bad:
                raise ToolInputError(
                    f"Unknown rarity_bucket {', '.join(bad)}; use one of {', '.join(RARITY_BUCKET_KEYS)}."
                )
        if items:
            clean[field] = list(dict.fromkeys(items))

    role = raw.get("pokemon_role")
    if role is not None and str(role).strip():
        role = str(role).strip()
        if role not in POKEMON_ROLES:
            raise ToolInputError(f"pokemon_role must be one of {', '.join(POKEMON_ROLES)}.")
        if role != "any":
            clean["pokemon_role"] = role

    language = raw.get("language")
    if language is not None and str(language).strip():
        matched = next((lang for lang in LANGUAGES if lang.lower() == str(language).strip().lower()), None)
        if matched is None:
            raise ToolInputError("language must be English, Japanese, or any.")
        if matched != "any":
            clean["language"] = matched

    for field in ("price_min_usd", "price_max_usd"):
        value = raw.get(field)
        if value is None:
            continue
        try:
            amount = float(value)
        except (TypeError, ValueError):
            raise ToolInputError(f"filter.{field} must be a number.") from None
        if amount < 0:
            raise ToolInputError(f"filter.{field} must be >= 0.")
        clean[field] = amount
    if (
        "price_min_usd" in clean
        and "price_max_usd" in clean
        and clean["price_min_usd"] > clean["price_max_usd"]
    ):
        raise ToolInputError("price_min_usd is greater than price_max_usd.")
    return clean


def uses_art_filters(card_filter: dict[str, Any]) -> bool:
    return any(field in card_filter for field in ART_FILTER_FIELDS)


def clamp_limit(value: Any, *, default: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        limit = int(value)
    except (TypeError, ValueError):
        raise ToolInputError("limit must be an integer.") from None
    if limit < 1 or limit > maximum:
        raise ToolInputError(f"limit must be between 1 and {maximum}.")
    return limit


def encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, *, kind: str) -> dict[str, Any] | None:
    if cursor is None or not str(cursor).strip():
        return None
    text = str(cursor).strip()
    try:
        padded = text + "=" * (-len(text) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except Exception:  # noqa: BLE001 - any garbage is the same caller error
        raise ToolInputError("cursor is invalid; pass next_cursor from the previous call.") from None
    if not isinstance(payload, dict) or payload.get("k") != kind:
        raise ToolInputError("cursor belongs to a different tool or query.")
    return payload
