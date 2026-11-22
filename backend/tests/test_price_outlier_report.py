"""tools/price_outlier_report.py on a seeded temp DB (read-only report)."""

from __future__ import annotations

import csv
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402
import price_outlier_report  # noqa: E402

TODAY = date(2026, 11, 21)


def day(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


class PriceOutlierReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = Path(self.tempdir.name) / "report.sqlite"
        conn = connect(self.db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(conn)
        for card_id, language in (("phantom", "Japanese"), ("stale", "Japanese"), ("ok", "English"),
                                  ("jumpy", "English")):
            upsert_card(
                conn, card_id=card_id, name=card_id.title(), set_name="Set", number="1", rarity="Rare",
                variant="Raw", language=language, source_provider="scrydex", source_record_id=card_id,
                set_id="set", set_ptcgo_code="SET", set_release_date="2020-01-01", artist=None,
                supertype="Pokémon", national_pokedex_numbers=[], image_url=None, source_payload={},
            )
        cells = [
            ("phantom", "scrydex", 1, "raw", "holofoil", "NM", None, None, 500.0),
            ("phantom", "scrydex", 1, "graded", "holofoil", None, "PSA", "10", 351.94),
            ("ok", "scrydex", 1, "raw", "holofoil", "NM", None, None, 100.0),
            ("ok", "scrydex", 2, "raw", "holofoil", "NM", None, None, 95.0),
            ("ok", "scrydex", 1, "graded", "holofoil", None, "PSA", "10", 300.0),
            ("stale", "scrydex", 125, "raw", "holofoil", "NM", None, None, 461.96),
            ("jumpy", "tcgcsv", 1, "raw_main", "Holofoil", "NM", None, None, 40.0),
            ("jumpy", "tcgcsv", 2, "raw_main", "Holofoil", "NM", None, None, 10.0),
        ]
        for card_id, provider, ago, lane, variant, condition, grader, grade, market in cells:
            conn.execute(
                "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
                "condition, grader, grade, currency_code, market, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?)",
                (card_id, provider, day(ago), lane, f"{lane}|{grader}|{grade}|{variant}|{condition}", variant,
                 condition, grader, grade, market, utc_now()),
            )
        conn.commit()
        conn.close()

    def test_finds_each_check_and_writes_csv(self) -> None:
        out = Path(self.tempdir.name) / "out.csv"
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            price_outlier_report.main(
                ["--database-path", str(self.db_path), "--out", str(out), "--today", TODAY.isoformat()]
            )
        rows = list(csv.DictReader(out.open()))
        found = {(row["check"], row["card_id"]) for row in rows}
        self.assertEqual(found, {("raw_over_psa10", "phantom"), ("stale", "stale"), ("jump", "jumpy")})
        stale = next(row for row in rows if row["check"] == "stale")
        self.assertEqual((stale["provider"], stale["lane"], stale["language"], stale["value_date"]),
                         ("scrydex", "raw", "Japanese", day(125)))
        self.assertIn("scrydex/raw/Japanese: 1", buffer.getvalue())

    def test_never_writes(self) -> None:
        before = self.db_path.stat().st_mtime_ns
        with redirect_stdout(io.StringIO()):
            price_outlier_report.main(["--database-path", str(self.db_path), "--today", TODAY.isoformat()])
        self.assertEqual(self.db_path.stat().st_mtime_ns, before)


if __name__ == "__main__":
    unittest.main()
