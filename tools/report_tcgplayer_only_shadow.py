"""Report the TCGplayer-only shadow classifications (plan P0,
docs/tcgplayer-only-catalog-plan-2026-09-29.md).

    python3 tools/report_tcgplayer_only_shadow.py \
        --database-path backend/data/spotlight_scanner.sqlite \
        --csv /tmp/tcgplayer_only_shadow.csv

Prints per-game/category counts by status, the groups with the most rows per
status, and the most valuable products per status and class (TCGplayer market
price as recorded at classification time), then writes every row to a CSV —
the input for eyeballing REVIEW rows and writing backend/tcgplayer_only_overrides.json.
Read-only: opens the database with mode=ro.
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import sqlite3
from pathlib import Path

STATUS_ORDER = ("shadow_linked", "shadow_missing", "review", "ignored", "linked", "created", "superseded")
CSV_FIELDS = (
    "product_id", "game", "category_id", "group_id", "group_name", "status", "reason", "class",
    "name", "number", "rarity", "version_label", "card_id", "proposed_card_id", "candidates",
    "mapping", "mapped_sets", "market_price", "tcgplayer_url", "image_url", "first_seen_at", "updated_at",
)


def load_rows(database_path: Path) -> list[dict]:
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        cursor = connection.execute(
            "SELECT product_id, category_id, group_id, game, status, card_id, proposed_card_id, "
            "version_label, evidence_json, first_seen_at, updated_at "
            "FROM tcgplayer_product_classifications"
        )
        columns = [column[0] for column in cursor.description]
        rows = []
        for values in cursor:
            row = dict(zip(columns, values))
            evidence = json.loads(row.pop("evidence_json") or "{}")
            pid = row["product_id"]
            row.update({
                "group_name": evidence.get("groupName"),
                "reason": evidence.get("reason"),
                "class": evidence.get("class"),
                "name": evidence.get("name"),
                "number": evidence.get("number"),
                "rarity": evidence.get("rarity"),
                "candidates": " ".join(evidence.get("candidates") or []),
                "mapping": evidence.get("mapping"),
                "mapped_sets": " ".join(evidence.get("mappedSets") or []),
                "market_price": evidence.get("marketPrice"),
                "tcgplayer_url": f"https://www.tcgplayer.com/product/{pid}",
                "image_url": f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_in_1000x1000.jpg",
            })
            rows.append(row)
        return rows
    finally:
        connection.close()


def _status_key(status: str) -> int:
    return STATUS_ORDER.index(status) if status in STATUS_ORDER else len(STATUS_ORDER)


def print_report(rows: list[dict], *, top: int) -> None:
    by_game: dict[tuple[str, int], collections.Counter] = collections.defaultdict(collections.Counter)
    for row in rows:
        by_game[(row["game"], row["category_id"])][row["status"]] += 1
    statuses = sorted({row["status"] for row in rows}, key=_status_key)
    print("== Counts by game/category ==")
    print(f"{'game':<12} {'cat':>4} " + " ".join(f"{s:>15}" for s in statuses) + f" {'total':>7}")
    for (game, category_id), counter in sorted(by_game.items()):
        cells = " ".join(f"{counter.get(s, 0):>15}" for s in statuses)
        print(f"{game:<12} {category_id:>4} {cells} {sum(counter.values()):>7}")

    for game in sorted({row["game"] for row in rows}):
        game_rows = [row for row in rows if row["game"] == game]
        print(f"\n== {game} ==")
        for status in statuses:
            subset = [row for row in game_rows if row["status"] == status]
            if not subset:
                continue
            reasons = collections.Counter(row["reason"] for row in subset).most_common(6)
            groups = collections.Counter(row["group_name"] for row in subset).most_common(top)
            print(f"-- {status} ({len(subset)}) reasons: {reasons}")
            print(f"   top groups: {groups}")
            for klass in sorted({row["class"] for row in subset}):
                priced = sorted(
                    (row for row in subset if row["class"] == klass and row["market_price"]),
                    key=lambda row: -row["market_price"],
                )[:top]
                unpriced = sum(1 for row in subset if row["class"] == klass and not row["market_price"])
                print(f"   [{klass}] top by market price ({unpriced} unpriced):")
                for row in priced:
                    target = row["card_id"] or row["proposed_card_id"] or row["candidates"]
                    print(f"     ${row['market_price']:>9.2f}  {row['product_id']:>7}  {row['name']}"
                          f"  #{row['number'] or '-'}  [{row['group_name']}]  -> {target}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--csv", help="write every classification row here")
    parser.add_argument("--top", type=int, default=10, help="rows per top-N list (default 10)")
    args = parser.parse_args(argv)

    rows = load_rows(Path(args.database_path))
    if not rows:
        print("no tcgplayer_product_classifications rows (shadow ingest not run yet?)")
        return 0
    print_report(rows, top=args.top)
    if args.csv:
        rows.sort(key=lambda row: (row["game"], _status_key(row["status"]), -(row["market_price"] or 0)))
        with open(args.csv, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nwrote {len(rows)} rows to {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
