"""Nightly-able, READ-ONLY price outlier report over card_price_history_cell.

Checks (USD; JPY cells FX-converted with the DB's cached FX snapshot):
  raw_over_psa10  a card's newest Scrydex raw NM price above its own PSA 10 (same
                  printing, newest graded day). The chat/MCP tools hide these
                  (price_untrusted); the app's phantom guard only fires at 1.5x on
                  single-printing cards.
  stale           a card that HAD prices in a provider lane whose newest cell is
                  older than --stale-days while that lane is still syncing
                  (lane's newest day is recent). Grouped by provider/lane/language.
  jump            day-over-day raw NM market move above --jump-ratio (either way)
                  between consecutive synced days of the last --jump-days days.

Opens the DB with mode=ro; never writes. Prints a summary and writes one CSV
(column `check` names the check).

Local:
  backend/.venv/bin/python backend/tools/price_outlier_report.py \\
      --database-path backend/data/spotlight_scanner.sqlite --out /tmp/price_outliers.csv

On the VM (read-only; run from the deployed checkout with its venv, off-peak —
the latest-day scan reads the whole cell index, ~tens of seconds on 27M rows):
  cd <backend checkout> && .venv/bin/python tools/price_outlier_report.py \\
      --database-path <path to spotlight_scanner.sqlite> --out /tmp/price_outliers_$(date +%F).csv
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import _amount_to_usd, _normalized_variant_label, _variant_match_key  # noqa: E402

LANES = ("raw", "raw_main", "graded")
CSV_COLUMNS = (
    "check", "card_id", "name", "set", "number", "language", "provider", "lane", "variant",
    "value_usd", "compare_usd", "ratio", "value_date", "compare_date", "detail",
)
CHUNK = 400


def connect_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def chunks(values: list[Any], size: int = CHUNK) -> Iterable[list[Any]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def latest_dates(connection: sqlite3.Connection) -> dict[tuple[str, str, str], str]:
    """(card_id, provider, lane) -> newest price_date. Covering-index scan."""
    rows = connection.execute(
        "SELECT card_id, provider, lane, MAX(price_date) FROM card_price_history_cell "
        f"WHERE lane IN ({','.join('?' for _ in LANES)}) GROUP BY card_id, provider, lane",
        LANES,
    ).fetchall()
    return {(str(r[0]), str(r[1]), str(r[2])): str(r[3]) for r in rows}


def card_meta(connection: sqlite3.Connection, card_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for chunk in chunks(sorted(set(card_ids))):
        for row in connection.execute(
            f"SELECT id, name, set_name, number, language FROM cards WHERE id IN ({','.join('?' for _ in chunk)})",
            chunk,
        ).fetchall():
            out[str(row["id"])] = dict(row)
    return out


def cells_on(
    connection: sqlite3.Connection, pairs: dict[str, str], provider: str, lane: str
) -> dict[str, list[sqlite3.Row]]:
    """card_id -> plain cells of `lane` on that card's given day."""
    out: dict[str, list[sqlite3.Row]] = defaultdict(list)
    ids = sorted(pairs)
    for chunk in chunks(ids):
        dates = sorted({pairs[card_id] for card_id in chunk})
        for row in connection.execute(
            "SELECT card_id, price_date, variant_key, condition, grader, grade, market, currency_code "
            "FROM card_price_history_cell "
            f"WHERE card_id IN ({','.join('?' for _ in chunk)}) AND price_date IN ({','.join('?' for _ in dates)}) "
            "AND provider = ? AND lane = ? AND market > 0 "
            "AND COALESCE(is_perfect, 0) = 0 AND COALESCE(is_signed, 0) = 0 AND COALESCE(is_error, 0) = 0",
            (*chunk, *dates, provider, lane),
        ).fetchall():
            if row["price_date"] == pairs.get(str(row["card_id"])):
                out[str(row["card_id"])].append(row)
    return out


def variant_key(value: Any) -> str:
    return _variant_match_key(_normalized_variant_label(value))


def usd(connection: sqlite3.Connection, market: Any, currency: Any) -> float | None:
    value = _amount_to_usd(connection, market, currency or "USD")
    return float(value) if value is not None else None


def raw_over_psa10(
    connection: sqlite3.Connection, latest: dict[tuple[str, str, str], str], provider: str, min_usd: float
) -> list[dict[str, Any]]:
    raw_days = {card: day for (card, prov, lane), day in latest.items() if prov == provider and lane == "raw"}
    graded_days = {card: day for (card, prov, lane), day in latest.items() if prov == provider and lane == "graded"}
    both = {card: raw_days[card] for card in raw_days if card in graded_days}
    raw_cells = cells_on(connection, both, provider, "raw")
    graded_cells = cells_on(connection, {card: graded_days[card] for card in both}, provider, "graded")
    found = []
    for card_id, cells in raw_cells.items():
        psa10: dict[str, float] = {}
        for cell in graded_cells.get(card_id, []):
            if str(cell["grader"] or "").upper() != "PSA":
                continue
            try:
                if float(cell["grade"]) != 10:
                    continue
            except (TypeError, ValueError):
                continue
            value = usd(connection, cell["market"], cell["currency_code"])
            if value:
                key = variant_key(cell["variant_key"])
                psa10[key] = min(value, psa10.get(key, value))
        for cell in cells:
            if str(cell["condition"] or "").upper() != "NM":
                continue
            key = variant_key(cell["variant_key"])
            raw = usd(connection, cell["market"], cell["currency_code"])
            slab = psa10.get(key)
            if raw is None or slab is None or raw < min_usd or raw <= slab:
                continue
            found.append(
                {
                    "check": "raw_over_psa10", "card_id": card_id, "provider": provider, "lane": "raw",
                    "variant": cell["variant_key"], "value_usd": round(raw, 2), "compare_usd": round(slab, 2),
                    "ratio": round(raw / slab, 2), "value_date": cell["price_date"],
                    "compare_date": graded_days[card_id],
                    "detail": f"raw NM {cell['market']} {cell['currency_code'] or 'USD'} vs PSA 10",
                }
            )
    return found


def stale(
    latest: dict[tuple[str, str, str], str], *, today: date, stale_days: int, live_days: int
) -> list[dict[str, Any]]:
    cutoff = (today - timedelta(days=stale_days)).isoformat()
    live_cutoff = (today - timedelta(days=live_days)).isoformat()
    lane_newest: dict[tuple[str, str], str] = {}
    for (_, provider, lane), day in latest.items():
        lane_newest[(provider, lane)] = max(day, lane_newest.get((provider, lane), day))
    found = []
    for (card_id, provider, lane), day in latest.items():
        if day >= cutoff or lane_newest[(provider, lane)] < live_cutoff:
            continue  # fresh, or the whole lane is paused (e.g. staging graded) - not a per-card gap
        found.append(
            {
                "check": "stale", "card_id": card_id, "provider": provider, "lane": lane,
                "value_date": day, "compare_date": lane_newest[(provider, lane)],
                "detail": f"no {provider} {lane} cell since {day}",
            }
        )
    return found


def recent_days(connection: sqlite3.Connection, provider: str, count: int) -> list[str]:
    """The provider's newest `count` distinct cell days, newest first (walks idx_cell_date)."""
    days: list[str] = []
    bound = "9999-12-31"
    while len(days) < count:
        row = connection.execute(
            "SELECT price_date FROM card_price_history_cell WHERE price_date < ? AND provider = ? "
            "ORDER BY price_date DESC LIMIT 1",
            (bound, provider),
        ).fetchone()
        if row is None:
            break
        days.append(str(row[0]))
        bound = str(row[0])
    return days


def jumps(
    connection: sqlite3.Connection, provider: str, lane: str, *, jump_days: int, ratio: float, min_usd: float
) -> list[dict[str, Any]]:
    days = recent_days(connection, provider, jump_days + 1)
    found = []
    for newer, older in zip(days, days[1:]):
        series: dict[tuple[str, str], dict[str, tuple[float, str]]] = defaultdict(dict)
        for row in connection.execute(
            "SELECT card_id, price_date, variant_key, market, currency_code FROM card_price_history_cell "
            "WHERE price_date IN (?, ?) AND provider = ? AND lane = ? AND UPPER(COALESCE(condition, 'NM')) = 'NM' "
            "AND market > 0 AND COALESCE(is_perfect, 0) = 0 AND COALESCE(is_signed, 0) = 0 "
            "AND COALESCE(is_error, 0) = 0",
            (newer, older, provider, lane),
        ).fetchall():
            value = usd(connection, row["market"], row["currency_code"])
            if value is not None:
                series[(str(row["card_id"]), str(row["variant_key"] or ""))][row["price_date"]] = (
                    value, f"{row['market']} {row['currency_code'] or 'USD'}"
                )
        for (card_id, variant), points in series.items():
            if newer not in points or older not in points:
                continue
            now, then = points[newer][0], points[older][0]
            if max(now, then) < min_usd or min(now, then) <= 0:
                continue
            move = now / then
            if move > ratio or move < 1 / ratio:
                found.append(
                    {
                        "check": "jump", "card_id": card_id, "provider": provider, "lane": lane,
                        "variant": variant or None, "value_usd": round(now, 2), "compare_usd": round(then, 2),
                        "ratio": round(move, 3), "value_date": newer, "compare_date": older,
                        "detail": f"{points[older][1]} -> {points[newer][1]}",
                    }
                )
    return found


def run(args: argparse.Namespace) -> int:
    connection = connect_readonly(Path(args.database_path))
    today = date.fromisoformat(args.today) if args.today else date.today()
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_price_history_cell'"
    ).fetchone() is None:
        print(f"{args.database_path}: no card_price_history_cell table; nothing to report.")
        return 0
    latest = latest_dates(connection)
    providers = sorted({provider for (_, provider, _) in latest})
    findings: list[dict[str, Any]] = []
    for provider in providers:
        findings += raw_over_psa10(connection, latest, provider, args.min_usd)
    findings += stale(latest, today=today, stale_days=args.stale_days, live_days=args.live_days)
    for provider, lane in sorted({(provider, lane) for (_, provider, lane) in latest if lane in ("raw", "raw_main")}):
        findings += jumps(connection, provider, lane, jump_days=args.jump_days, ratio=args.jump_ratio,
                          min_usd=args.min_usd)
    meta = card_meta(connection, [item["card_id"] for item in findings])
    for item in findings:
        card = meta.get(item["card_id"], {})
        item.update(
            name=card.get("name"), set=card.get("set_name"), number=card.get("number"),
            language=card.get("language") or "unknown",
        )

    print(f"Price outlier report for {args.database_path} (today {today.isoformat()})")
    print(f"  cards with cells: {len({card for (card, _, _) in latest}):,}")
    by_check = Counter(item["check"] for item in findings)
    print(f"  raw_over_psa10: {by_check['raw_over_psa10']:,}")
    for (language,), count in sorted(
        Counter((item["language"],) for item in findings if item["check"] == "raw_over_psa10").items()
    ):
        print(f"    {language}: {count:,}")
    print(f"  stale (> {args.stale_days}d, lane still syncing): {by_check['stale']:,}")
    for (provider, lane, language), count in sorted(
        Counter((i["provider"], i["lane"], i["language"]) for i in findings if i["check"] == "stale").items()
    ):
        print(f"    {provider}/{lane}/{language}: {count:,}")
    print(f"  day-over-day jumps > {args.jump_ratio:g}x (last {args.jump_days} synced days): {by_check['jump']:,}")
    for (provider, lane), count in sorted(
        Counter((i["provider"], i["lane"]) for i in findings if i["check"] == "jump").items()
    ):
        print(f"    {provider}/{lane}: {count:,}")
    for check in ("raw_over_psa10", "jump"):
        worst = sorted((i for i in findings if i["check"] == check),
                       key=lambda i: -max(i["ratio"], 1 / i["ratio"]) if i["ratio"] else 0)[: args.top]
        if worst:
            print(f"  worst {check}:")
            for item in worst:
                print(f"    {item['card_id']} {item['name']!s} ({item['set']} {item['number']}) "
                      f"${item['value_usd']:,.2f} vs ${item['compare_usd']:,.2f} x{item['ratio']}")

    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction="ignore")
            writer.writeheader()
            for item in sorted(findings, key=lambda i: (i["check"], i.get("provider") or "", i["card_id"])):
                writer.writerow(item)
        print(f"  CSV: {args.out} ({len(findings):,} rows)")
    connection.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--out", help="CSV path (omit for summary only)")
    parser.add_argument("--stale-days", type=int, default=14)
    parser.add_argument("--live-days", type=int, default=3,
                        help="a lane counts as still syncing if its newest cell is within this many days")
    parser.add_argument("--jump-days", type=int, default=1, help="consecutive synced-day pairs to scan")
    parser.add_argument("--jump-ratio", type=float, default=3.0)
    parser.add_argument("--min-usd", type=float, default=1.0, help="ignore prices under this (both sides)")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--today", help="YYYY-MM-DD (tests)")
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
