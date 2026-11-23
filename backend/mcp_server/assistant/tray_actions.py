"""Scan-tray actions: chat → the app's scan tray (added 2026-11-22).

The scan tray is client state (rows, each with its matched card, candidates, printing,
condition or grade). A chat opened from the scanner sends a compact copy of its rows as
`context.tray_rows` on every turn; the model refers to them by row number and these tools
turn that into a ProposedAction the APP applies to the live tray on Confirm:

- `add_tray_to_collection`: the rows to file, each exactly as the tray shows it (the app
  runs the scanner's own add path, so scan confirmation + leaving the tray match ADD ALL);
- `swap_tray_card`: change one row's matched card (the app reuses the tray's change-match
  path: candidates[] are kept, never dropped);
- `remove_tray_card`: drop one row from the tray.

Nothing here writes anything server-side. Row refs are opaque client ids (the capture id);
the app re-checks on Confirm that the row still holds `card_id` and says so honestly if not.
"""

from __future__ import annotations

import re
from typing import Any

MAX_TRAY_ROWS = 20
MAX_ROW_REF_CHARS = 80
MAX_VARIANT_CHARS = 80
MAX_ROW_QUANTITY = 999
CONDITIONS = ("NM", "LP", "MP", "HP", "DMG")
MAX_SUMMARY_NAMES = 3

ADD_TRAY_TOOL = "tray_propose_add"
SWAP_TRAY_TOOL = "tray_propose_swap"
REMOVE_TRAY_TOOL = "tray_propose_remove"
TRAY_TOOLS = (ADD_TRAY_TOOL, SWAP_TRAY_TOOL, REMOVE_TRAY_TOOL)

NO_TRAY_ERROR = (
    "No scan tray came with this chat. Tray changes only work in a chat opened from the scanner's tray: "
    "tell the user to tap the Ekalight button on their scan tray."
)

_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")

# Non-strict on purpose, so NOT named propose_*: every propose_* tool is strict, and strict
# tools share one compiled grammar with a hard size cap (engine._strict_tool). These only
# name rows; the server validates every value.
TRAY_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": ADD_TRAY_TOOL,
        "description": (
            "Propose adding cards from the user's scan tray to their collection (\"add these/all/the tray to my "
            "collection\"). rows = the tray row numbers they mean; [] = every row. Each row is filed exactly as the "
            "tray shows it (printing, condition or grade, quantity), so never ask for those. Nothing changes until "
            "the user taps Confirm."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rows": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Row numbers from the scan tray list; [] = every row.",
                },
            },
            "required": [],
            "additionalProperties": False,
        },
    },
    {
        "name": SWAP_TRAY_TOOL,
        "description": (
            "Propose changing which card one scan tray row is matched to (\"swap the Charizard for the Obsidian "
            "Flames one\", \"that's the wrong printing\", \"it's actually …\"). row = its tray row number; "
            "to_card_id = the right card (from search_cards: same card name, the set/number the user means). "
            "Nothing changes until the user taps Confirm."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "row": {"type": "integer", "description": "Tray row number."},
                "to_card_id": {"type": "string", "description": "card_id of the card the row should be."},
            },
            "required": ["row", "to_card_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": REMOVE_TRAY_TOOL,
        "description": (
            "Propose removing one row from the user's scan tray (not from their collection). row = its tray row "
            "number. Nothing changes until the user taps Confirm."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"row": {"type": "integer", "description": "Tray row number."}},
            "required": ["row"],
            "additionalProperties": False,
        },
    },
]


class TrayInputError(ValueError):
    """A tray tool argument the model must fix (reported back as a tool error)."""


def _clean(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", _CONTROL.sub(" ", str(value))).strip()[:limit].strip()


def _optional(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    cleaned = _clean(value, limit)
    return cleaned or None


def parse_tray_rows(raw: Any) -> tuple[list[dict[str, Any]], str | None]:
    """(rows, error). Absent = []. A malformed shape is a 400 like the rest of `context`;
    an unknown condition is dropped (not rejected) so a newer app's code never 400s."""
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return [], "context.tray_rows must be a list"
    if len(raw) > MAX_TRAY_ROWS:
        return [], f"context.tray_rows holds at most {MAX_TRAY_ROWS} rows"
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            return [], "context.tray_rows items must be objects"
        row_ref, card_id = item.get("row_ref"), item.get("card_id")
        if not isinstance(row_ref, str) or not isinstance(card_id, str):
            return [], "context.tray_rows items need row_ref and card_id strings"
        for key in ("condition", "grader", "grade", "variant"):
            if item.get(key) is not None and not isinstance(item.get(key), str):
                return [], f"context.tray_rows {key} must be a string or null"
        quantity = item.get("quantity", 1)
        if quantity is None:
            quantity = 1
        if isinstance(quantity, bool) or not isinstance(quantity, int):
            return [], "context.tray_rows quantity must be an integer"
        row_ref, card_id = _clean(row_ref, MAX_ROW_REF_CHARS), _clean(card_id, 120)
        if not row_ref or not card_id or row_ref in seen:
            continue
        seen.add(row_ref)
        grader = _optional(item.get("grader"), 12)
        grade = _optional(item.get("grade"), 12) if grader else None
        condition = (_optional(item.get("condition"), 4) or "").upper()
        rows.append({
            "row_ref": row_ref,
            "card_id": card_id,
            "condition": None if grader else (condition if condition in CONDITIONS else "NM"),
            "grader": grader.upper() if grader else None,
            "grade": grade,
            "quantity": max(1, min(int(quantity), MAX_ROW_QUANTITY)),
            "variant": _optional(item.get("variant"), MAX_VARIANT_CHARS),
        })
    return rows, None


def row_finish(row: dict[str, Any]) -> str:
    """'NM' / 'PSA 10' — how the row will be filed."""
    if row.get("grader"):
        return f"{row['grader']} {row.get('grade') or ''}".strip()
    return str(row.get("condition") or "NM")


def tray_rows_note(rows: list[dict[str, Any]], summaries: dict[str, dict[str, Any]], *, opened_with_tray: bool) -> str | None:
    """The per-turn tray block, one numbered line per row. On the first turn (the tray ids
    came with the question) it IS the scan-tray note; on later turns it just keeps the rows
    in reach for tray actions."""
    lines = []
    for index, row in enumerate(rows, start=1):
        summary = summaries.get(row["card_id"]) or {}
        price = summary.get("price_usd")
        bits = [
            str(summary.get("name") or "Unknown card"),
            str(summary.get("set") or "?"),
            f"#{summary.get('number') or '?'}",
            "$" + format(price, ",.2f") if isinstance(price, (int, float)) else "no price",
        ]
        if row.get("variant") and not row.get("grader"):
            bits.append(str(row["variant"]))
        bits.append(row_finish(row))
        if row.get("quantity", 1) > 1:
            bits.append(f"×{row['quantity']}")
        lines.append(f"- Row {index}: " + " · ".join(bits) + f" (card_id: {row['card_id']})")
    if not lines:
        return None
    if opened_with_tray:
        header = "The user's scan tray contains (row numbers are for tray actions):"
    else:
        header = (
            "The user's scan tray is still open behind this chat (row numbers are for tray actions; bring it up "
            "only when the user refers to their scanned cards):"
        )
    return header + "\n" + "\n".join(lines)


def resolve_row(rows: list[dict[str, Any]], value: Any) -> tuple[int, dict[str, Any]]:
    if not rows:
        raise TrayInputError(NO_TRAY_ERROR)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise TrayInputError("row must be a tray row number.")
    number = int(value)
    if not 1 <= number <= len(rows):
        raise TrayInputError(f"Row {number} isn't in the scan tray (it has {len(rows)} rows).")
    return number, rows[number - 1]


def resolve_rows(rows: list[dict[str, Any]], value: Any) -> list[tuple[int, dict[str, Any]]]:
    if not rows:
        raise TrayInputError(NO_TRAY_ERROR)
    if value is None or value == []:
        return list(enumerate(rows, start=1))
    if not isinstance(value, list):
        raise TrayInputError("rows must be a list of tray row numbers ([] = every row).")
    picked: dict[int, dict[str, Any]] = {}
    for item in value:
        number, row = resolve_row(rows, item)
        picked[number] = row
    return sorted(picked.items())


def _names(labels: list[str]) -> str:
    shown = labels[:MAX_SUMMARY_NAMES]
    more = len(labels) - len(shown)
    return ", ".join(shown) + (f" +{more} more" if more > 0 else "")


def add_action_parts(
    picked: list[tuple[int, dict[str, Any]]], cards: dict[str, dict[str, Any]], label: Any
) -> tuple[str, dict[str, Any]]:
    """(summary, params) for add_tray_to_collection. `label(card)` = the toolbox card label."""
    rows_out = []
    names = []
    copies = 0
    for number, row in picked:
        card = cards[row["card_id"]]
        names.append(str(card.get("name") or row["card_id"]))
        copies += row["quantity"]
        rows_out.append({
            "row": number,
            "row_ref": row["row_ref"],
            "card_id": row["card_id"],
            "quantity": row["quantity"],
            "condition": row["condition"],
            "variant_name": None if row["grader"] else row["variant"],
            "grader": row["grader"],
            "grade": row["grade"],
        })
    if len(picked) == 1:
        _, row = picked[0]
        parts = [f"Add {label(cards[row['card_id']])}"]
        if row["variant"] and not row["grader"]:
            parts.append(row["variant"])
        parts.append(row_finish(row))
        parts.append(f"×{row['quantity']}")
        summary = " · ".join(parts)
    else:
        summary = f"Add {copies} scanned cards to your collection: {_names(names)}"
    return summary, {"rows": rows_out}


def swap_action_parts(
    number: int, row: dict[str, Any], source: dict[str, Any], target: dict[str, Any], tile: dict[str, Any] | None,
    label: Any,
) -> tuple[str, dict[str, Any]]:
    summary = f"Swap {label(source)} → {label(target)}"
    to_card = {
        "card_id": target["id"],
        "name": target.get("name"),
        "set": target.get("setName"),
        "number": target.get("number"),
        "language": (tile or {}).get("language"),
        "image_small_url": (tile or {}).get("image_small_url"),
        "price_usd": (tile or {}).get("price_usd"),
    }
    return summary, {
        "row": number,
        "row_ref": row["row_ref"],
        "from_card_id": row["card_id"],
        "to_card_id": target["id"],
        "to_card": to_card,
    }


def remove_action_parts(number: int, row: dict[str, Any], card: dict[str, Any], label: Any) -> tuple[str, dict[str, Any]]:
    return f"Remove {label(card)} from your scan tray", {
        "row": number, "row_ref": row["row_ref"], "card_id": row["card_id"],
    }
