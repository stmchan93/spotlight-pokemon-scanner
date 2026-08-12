#!/usr/bin/env python3
"""Re-file deck entries that were orphaned out of their collection.

`replace_deck_entry` used to mint the new row without a `collection_id` whenever
an edit changed the identity key (EN/JP swap, grade, variant, condition). A
scoped Collection read is `AND collection_id = ?`, which cannot match NULL, so
those holdings vanished from the collection the owner was looking at while still
counting in the un-scoped "All Collection" view.

The server no longer writes NULL. This repairs the rows already written that way.

WHERE A ROW GOES BACK TO
------------------------
1. Its predecessor's collection, when one is recoverable. The replace zeroed the
   old row rather than deleting it, and that row still carries the original
   `collection_id`. The two are paired through `deck_entry_events`: the new row
   gets a `replace_in` and the old a `replace_out`, both stamped with the same
   `created_at` for the same owner.
2. Otherwise the owner's default collection — the same destination the server's
   own lazy backfill uses, and the one place every account is guaranteed to have.

Idempotent: only rows with a NULL/empty `collection_id` are touched.

Usage:
    python3 tools/repair_orphaned_deck_entry_collections.py --db <path> --dry-run
    python3 tools/repair_orphaned_deck_entry_collections.py --db <path> --apply
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def _default_collection_id(con: sqlite3.Connection, owner_user_id: str) -> str | None:
    """The owner's default collection — first by sort order, matching
    `_ensure_owner_collections`. None when the owner has no collections at all
    (nothing to adopt into; the server creates one on their next touch)."""
    row = con.execute(
        """
        SELECT id FROM collections
        WHERE owner_user_id = ?
        ORDER BY sort_order, created_at, id
        LIMIT 1
        """,
        (owner_user_id,),
    ).fetchone()
    return str(row["id"]).strip() if row is not None else None


def _predecessor_collection_id(con: sqlite3.Connection, entry: sqlite3.Row) -> str | None:
    """The collection the row was in BEFORE the edit that orphaned it.

    Pairs this entry's `replace_in` with the `replace_out` written for the same
    owner at the same instant, then reads the collection off that older row.
    Returns None when the pairing is ambiguous — a guess here would silently
    file someone's card into the wrong collection, which is the bug, not the fix.
    """
    replace_in = con.execute(
        """
        SELECT created_at, owner_user_id
        FROM deck_entry_events
        WHERE deck_entry_id = ?
          AND event_kind = 'replace_in'
        ORDER BY created_at ASC
        LIMIT 1
        """,
        (str(entry["id"]),),
    ).fetchone()
    if replace_in is None:
        return None

    candidates = con.execute(
        """
        SELECT DISTINCT previous.collection_id AS collection_id
        FROM deck_entry_events AS event
        JOIN deck_entries AS previous ON previous.id = event.deck_entry_id
        WHERE event.event_kind = 'replace_out'
          AND event.created_at = ?
          AND IFNULL(event.owner_user_id, '') = IFNULL(?, '')
          AND previous.id != ?
          AND TRIM(IFNULL(previous.collection_id, '')) != ''
        """,
        (str(replace_in["created_at"]), replace_in["owner_user_id"], str(entry["id"])),
    ).fetchall()
    if len(candidates) != 1:
        return None
    return str(candidates[0]["collection_id"]).strip() or None


def run(db_path: Path, *, apply_changes: bool) -> int:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row

    orphans = con.execute(
        """
        SELECT id, owner_user_id, card_id, quantity
        FROM deck_entries
        WHERE TRIM(IFNULL(collection_id, '')) = ''
        ORDER BY owner_user_id, id
        """
    ).fetchall()

    if not orphans:
        print("No orphaned deck entries. Nothing to repair.")
        con.close()
        return 0

    default_cache: dict[str, str | None] = {}
    recovered = 0
    defaulted = 0
    skipped = 0

    for entry in orphans:
        owner = str(entry["owner_user_id"] or "").strip()
        target = _predecessor_collection_id(con, entry)
        source = "predecessor"
        if target is None:
            if owner not in default_cache:
                default_cache[owner] = _default_collection_id(con, owner) if owner else None
            target = default_cache[owner]
            source = "default"

        if target is None:
            skipped += 1
            print(f"  SKIP  {entry['id']} owner={owner or '<none>'} — owner has no collection")
            continue

        if source == "predecessor":
            recovered += 1
        else:
            defaulted += 1
        print(
            f"  {'SET ' if apply_changes else 'PLAN'}  {entry['id']} "
            f"card={entry['card_id']} qty={entry['quantity']} -> {target} ({source})"
        )
        if apply_changes:
            con.execute(
                "UPDATE deck_entries SET collection_id = ? WHERE id = ?",
                (target, str(entry["id"])),
            )

    if apply_changes:
        con.commit()

    print(
        f"\n{'Repaired' if apply_changes else 'Would repair'} {recovered + defaulted} "
        f"of {len(orphans)} orphaned entries "
        f"({recovered} restored to their original collection, "
        f"{defaulted} adopted by the owner's default, {skipped} skipped)."
    )
    if not apply_changes:
        print("Dry run — nothing was written. Re-run with --apply.")

    remaining = con.execute(
        "SELECT COUNT(*) AS total FROM deck_entries WHERE TRIM(IFNULL(collection_id, '')) = ''"
    ).fetchone()
    print(f"Orphaned entries remaining: {remaining['total']}")
    con.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path, help="Path to the SQLite database")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Report only; write nothing")
    mode.add_argument("--apply", action="store_true", help="Write the repairs")
    args = parser.parse_args()
    return run(args.db, apply_changes=bool(args.apply))


if __name__ == "__main__":
    raise SystemExit(main())
