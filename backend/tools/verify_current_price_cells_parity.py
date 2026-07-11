"""Current-price cells-vs-JSON parity harness.

Verifies that the cells-first resolution added to
``SpotlightScanService._pricing_summary_from_snapshot_row`` produces the same
CURRENT-price summary (the dict the card detail page / deck_entries render) as
the legacy JSON-context path, for cards that have normalized price-history cells.

It is READ-ONLY: it opens the SQLite DB, reads ``card_price_snapshots`` plus the
latest-date cells, and compares. It never writes, commits, or migrates. Safe to
run against the real staging DB.

For each sampled card it computes the pricing summary two ways against the SAME
snapshot row:
  - OLD: ``_pricing_summary_from_snapshot_row(row, ..., day_cells=None)``  (JSON)
  - NEW: ``_pricing_summary_from_snapshot_row(row, ..., day_cells=<cells>)`` (cells)
where ``<cells>`` are the normalized cells for that card's latest price_date.

Graded cards are checked in THREE context shapes per (grader, grade):
  - plain (no variant, no hints),
  - preferred_variant = each variant label the snapshot carries (tier-1 exact),
  - variant_hints inferred from each variant label (tier-3 ranked resolution —
    the 2026-07 re-port resolves hinted contexts ON the cells path via
    ``_resolve_best_graded_cell`` instead of the June defer-to-JSON, so hinted
    parity is now part of the bar, not an exclusion).

Parity is asserted on the price-bearing fields (the migration's parity bar):
``currencyCode, low, market, mid, high, directLow, trend, variant, provider,
grader, grade, pricingMode``. The ``payload`` / ``trendsPct`` fields are NOT
compared: cells do not persist them, so the cells path returns
``payload`` sourced from ``source_payload_json`` and ``trendsPct=None`` — a known,
bounded divergence that the ``card_price_history_daily.source_payload_json`` column
is itself slated to be dropped in the final migration phase. (The graded trust
fields confidenceLabel/confidenceLevel/compCount merge from the durable
``ppt_graded_signals`` side table on BOTH paths, so they only differ when no
signal row exists and the JSON entry's own payload carried them.) Pass
``--include-payload`` to see those differences too.

Known, deliberate residual divergences a mismatch line can reflect:
  - the cells-only corrupt-pull guard: when it trips, the cells helper yields
    nothing and the summary falls back to the JSON blobs — output-identical, so
    it does NOT show up here; but the raw PHANTOM check's PSA-10 side resolves
    through the guarded cell resolver, so a guard-tripped PSA 10 can leave a
    cells-path raw price unsuppressed where JSON suppressed it (conservative
    direction; expected to be ~0 rows in practice).

Usage (read-only):
    python3 tools/verify_current_price_cells_parity.py \
        --database-path data/spotlight_scanner.sqlite --limit 500

    # against staging copy:
    python3 tools/verify_current_price_cells_parity.py \
        --database-path /path/to/staging.sqlite --limit 2000
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Force the cells read source ON for this process so price_history_cells_enabled()
# is True and the cells-first branch is exercised. This only affects which store
# the resolver READS; the harness never writes.
os.environ["PRICE_HISTORY_SOURCE"] = "cells"

import json  # noqa: E402

from catalog_tools import connect, pricing_provider  # noqa: E402
from server import SpotlightScanService  # noqa: E402

# Price-bearing fields that MUST match byte-for-byte between the two paths.
PRICE_FIELDS = (
    "currencyCode",
    "low",
    "market",
    "mid",
    "high",
    "directLow",
    "trend",
    "variant",
    "provider",
    "grader",
    "grade",
    "pricingMode",
)
# Fields cells legitimately cannot reproduce (no payload/trendsPct on a cell).
PAYLOAD_FIELDS = (
    "payload",
    "trendsPct",
    "pricingTier",
    "confidenceLabel",
    "confidenceLevel",
    "compCount",
    "recentCompCount",
    "lastSoldPrice",
    "lastSoldAt",
    "bucketKey",
    "methodologySummary",
)


class _ParityShim(SpotlightScanService):
    """A SpotlightScanService that does NOTHING in __init__ except hold a
    connection, so the heavy/writing bootstrap (schema patches, visual index)
    never runs. All the pricing methods it borrows from the base class are pure,
    read-only reads against ``self.connection``."""

    def __init__(self, connection: sqlite3.Connection) -> None:  # noqa: D401
        self._conn = connection

    @property
    def connection(self) -> sqlite3.Connection:  # type: ignore[override]
        return self._conn


def _latest_price_date(connection: sqlite3.Connection, card_id: str) -> str | None:
    row = connection.execute(
        """
        SELECT price_date
        FROM card_price_history_daily
        WHERE card_id = ? AND provider = ?
        ORDER BY price_date DESC, updated_at DESC
        LIMIT 1
        """,
        (card_id, pricing_provider()),
    ).fetchone()
    return str(row["price_date"]) if row is not None and row["price_date"] is not None else None


def _day_cells(connection: sqlite3.Connection, card_id: str, price_date: str) -> list[sqlite3.Row]:
    # Provider-scoped like the production prefetch (_price_history_cells_by_card_and_date)
    # so a DB carrying a second provider's cells cannot skew the comparison.
    return connection.execute(
        # ORDER BY rowid = writer order = the JSON blob's entry order — the same
        # ordering the product's day-cell readers use (catalog_tools). Without it
        # this harness feeds the resolver index-ordered cells the app never sees.
        "SELECT * FROM card_price_history_cell WHERE card_id = ? AND price_date = ? AND provider = ? ORDER BY rowid",
        (card_id, price_date, pricing_provider()),
    ).fetchall()


def _sig(pricing: dict | None, fields: tuple[str, ...]) -> tuple | None:
    if pricing is None:
        return None
    return tuple(pricing.get(f) for f in fields)


def _graded_contexts_for(connection: sqlite3.Connection, card_id: str) -> str:
    row = connection.execute(
        "SELECT graded_contexts_json FROM card_price_snapshots WHERE card_id = ?",
        (card_id,),
    ).fetchone()
    return str(row["graded_contexts_json"] or "{}") if row is not None else "{}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-path",
        default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"),
        help="Path to the SQLite DB (read-only). Defaults to the local data path.",
    )
    parser.add_argument("--limit", type=int, default=500, help="Max cards to check per lane.")
    parser.add_argument("--show-accepted", action="store_true", help="List accepted-class divergences too.")
    parser.add_argument(
        "--include-payload",
        action="store_true",
        help="Also report payload/trendsPct differences (expected, informational).",
    )
    parser.add_argument(
        "--show",
        type=int,
        default=20,
        help="How many mismatching cards to print in detail.",
    )
    args = parser.parse_args()

    database_path = Path(args.database_path)
    if not database_path.exists():
        print(f"ERROR: database not found: {database_path}")
        return 2

    connection = connect(database_path)
    connection.row_factory = sqlite3.Row

    # Cells table must exist for a meaningful comparison.
    has_cells = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='card_price_history_cell'"
    ).fetchone()
    if has_cells is None:
        print("ERROR: card_price_history_cell table is absent in this DB; nothing to compare.")
        print("       (Run against a DB that has been backfilled with cells.)")
        return 2

    shim = _ParityShim(connection)

    # Sample RAW cards: snapshots with raw context data.
    raw_card_ids = [
        str(r["card_id"])
        for r in connection.execute(
            """
            SELECT card_id
            FROM card_price_snapshots
            WHERE raw_contexts_json IS NOT NULL AND raw_contexts_json != '{}'
            ORDER BY card_id
            LIMIT ?
            """,
            (args.limit,),
        ).fetchall()
    ]
    # Sample GRADED cards: snapshots that actually carry graded entries.
    graded_card_ids = [
        str(r["card_id"])
        for r in connection.execute(
            """
            SELECT card_id
            FROM card_price_snapshots
            WHERE graded_contexts_json LIKE '%"market"%'
            ORDER BY card_id
            LIMIT ?
            """,
            (args.limit,),
        ).fetchall()
    ]

    checked = 0
    skipped_no_cells = 0
    price_mismatches: list[tuple[str, str, tuple | None, tuple | None]] = []
    payload_mismatches: list[str] = []

    def _compare(card_id: str, pricing_context, tag: str) -> None:
        nonlocal checked, skipped_no_cells
        snapshot_row = connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id = ? LIMIT 1",
            (card_id,),
        ).fetchone()
        if snapshot_row is None:
            return
        price_date = _latest_price_date(connection, card_id)
        if not price_date:
            return
        cells = _day_cells(connection, card_id, price_date)
        if not cells:
            skipped_no_cells += 1
            return
        json_pricing = shim._pricing_summary_from_snapshot_row(
            snapshot_row, pricing_context=pricing_context, day_cells=None
        )
        cells_pricing = shim._pricing_summary_from_snapshot_row(
            snapshot_row, pricing_context=pricing_context, day_cells=cells
        )
        checked += 1
        if _sig(json_pricing, PRICE_FIELDS) != _sig(cells_pricing, PRICE_FIELDS):
            # Classify into the ACCEPTED divergence classes (ratified 2026-07-11
            # after the full-DB run: 150,072 comparisons, 11 divergences, zero
            # wrong prices) vs unexplained. See the show-week runbook.
            klass = "unexplained"
            if pricing_context.is_graded and cells_pricing is None and json_pricing is not None:
                # Guard-trip: the cells-only corrupt-pull guard refused a record
                # the JSON path serves. Prove it by re-picking WITHOUT the guard.
                from catalog_tools import _pick_graded_item, _cell_field as _cf
                grader_key = str(pricing_context.grader or "").strip().upper()
                grade_key = str(pricing_context.grade or "").strip().upper()
                matches = [
                    c for c in cells
                    if str(_cf(c, "lane") or "") == "graded"
                    and str(_cf(c, "grader") or "").strip().upper() == grader_key
                    and str(_cf(c, "grade") or "").strip().upper() == grade_key
                ]
                guardless = _pick_graded_item(
                    matches,
                    variant=pricing_context.preferred_variant,
                    get_variant=lambda c: _cf(c, "variant_key"),
                    get_market=lambda c: _cf(c, "market"),
                    is_special=lambda c: any(bool(_cf(c, f)) for f in ("is_perfect", "is_signed", "is_error")),
                ) if matches else None
                if guardless is not None:
                    klass = "guard_trip"
            elif not pricing_context.is_graded and cells_pricing is not None:
                json_priced = json_pricing is not None and any(
                    isinstance(json_pricing.get(k), (int, float)) for k in ("market", "low", "mid", "high")
                )
                cells_priced = any(
                    isinstance(cells_pricing.get(k), (int, float)) for k in ("market", "low", "mid", "high")
                )
                if cells_priced and not json_priced:
                    klass = "cells_fills_blank"
            price_mismatches.append(
                (card_id, tag, _sig(json_pricing, PRICE_FIELDS), _sig(cells_pricing, PRICE_FIELDS), klass)
            )
        if args.include_payload and _sig(json_pricing, PAYLOAD_FIELDS) != _sig(cells_pricing, PAYLOAD_FIELDS):
            payload_mismatches.append(f"{card_id} [{tag}]")

    print(f"Checking up to {len(raw_card_ids)} raw + {len(graded_card_ids)} graded cards...")

    for card_id in raw_card_ids:
        _compare(card_id, shim._raw_pricing_context(), "raw")

    for card_id in graded_card_ids:
        # Resolve a (grader, grade) the snapshot actually carries so the graded
        # context resolution has a real target.
        contexts = json.loads(_graded_contexts_for(connection, card_id) or "{}")
        graders = contexts.get("graders") if isinstance(contexts, dict) else None
        if not isinstance(graders, dict) or not graders:
            continue
        grader = next(iter(graders))
        grade_map = graders.get(grader) or {}
        if not isinstance(grade_map, dict) or not grade_map:
            continue
        grade = next(iter(grade_map))
        # Shape 1: plain (no variant, no hints) — the simple-resolver tier.
        _compare(
            card_id,
            shim._slab_pricing_context(grader=grader, grade=grade),
            f"graded {grader} {grade}",
        )
        # Variant labels this grade actually carries, for the exact + hinted tiers.
        entries = grade_map.get(grade)
        variant_labels: list[str] = []
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    label = str(entry.get("variant") or "").strip()
                    if label and label not in variant_labels:
                        variant_labels.append(label)
        for label in variant_labels:
            # Shape 2: preferred_variant (tier-1 exact short-circuit).
            _compare(
                card_id,
                shim._slab_pricing_context(grader=grader, grade=grade, preferred_variant=label),
                f"graded {grader} {grade} variant={label}",
            )
            # Shape 3: variant_hints inferred from the label text (tier-3 ranked
            # resolution — the piece the June cutover deferred to JSON and the
            # 2026-07 re-port resolves natively on cells).
            hints = SpotlightScanService._inferred_slab_variant_hints(
                label, parsed_label_text=()
            )
            _compare(
                card_id,
                shim._slab_pricing_context(grader=grader, grade=grade, variant_hints=hints),
                f"graded {grader} {grade} hints({label})",
            )

    print("=" * 70)
    print(f"Checked (card had cells):      {checked}")
    print(f"Skipped (no cells for latest): {skipped_no_cells}")
    guard_trips = [m for m in price_mismatches if m[4] == "guard_trip"]
    fills_blank = [m for m in price_mismatches if m[4] == "cells_fills_blank"]
    unexplained = [m for m in price_mismatches if m[4] == "unexplained"]
    print(f"PRICE-FIELD divergences:       {len(price_mismatches)}")
    print(f"  guard-trips (accepted):      {len(guard_trips)}  — corrupt-pull guard gaps a suspect record JSON serves")
    print(f"  cells-fills-blank (accepted):{len(fills_blank)}  — cells price a card JSON leaves blank")
    print(f"  UNEXPLAINED:                 {len(unexplained)}")
    if args.include_payload:
        print(f"payload/trendsPct mismatches:  {len(payload_mismatches)} (expected, informational)")
    print("=" * 70)

    if unexplained:
        print(f"\nFirst {min(args.show, len(unexplained))} UNEXPLAINED mismatches:")
        for card_id, tag, json_sig, cells_sig, _k in unexplained[: args.show]:
            print(f"  card_id={card_id} [{tag}]")
            print(f"    JSON : {dict(zip(PRICE_FIELDS, json_sig)) if json_sig else None}")
            print(f"    CELLS: {dict(zip(PRICE_FIELDS, cells_sig)) if cells_sig else None}")
        print("\nRESULT: MISMATCH — unexplained divergences. Investigate above.")
        return 1
    if price_mismatches:
        print(f"\nAccepted-class divergences only (use --show-accepted to list):")
        if getattr(args, "show_accepted", False):
            for card_id, tag, json_sig, cells_sig, k in price_mismatches[: args.show]:
                print(f"  [{k}] card_id={card_id} [{tag}]")
        print("\nRESULT: PASS — 0 unexplained; residual divergences are the ratified safe classes.")
        return 0

    print("\nRESULT: PASS — cells path is byte-identical to JSON on price fields for every checked card.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
