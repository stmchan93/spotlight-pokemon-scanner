from __future__ import annotations

import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


class PortfolioImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "portfolio-imports.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _insert_card(
        self,
        *,
        card_id: str,
        name: str,
        set_name: str,
        number: str,
        set_code: str,
        language: str = "English",
    ) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number=number,
            rarity="Rare",
            variant="Raw",
            language=language,
            source_provider="scrydex",
            source_record_id=card_id,
            set_id=set_code.lower(),
            set_ptcgo_code=set_code,
            set_release_date="2026-04-20",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def test_preview_tcgplayer_csv_stays_conservative(self) -> None:
        self._insert_card(
            card_id="obf-charizard-ex-223",
            name="Charizard ex",
            set_name="Obsidian Flames",
            number="223/197",
            set_code="OBF",
        )
        self._insert_card(
            card_id="svp-charizard-ex-074",
            name="Charizard ex",
            set_name="Scarlet & Violet Promo",
            number="074/SV-P",
            set_code="SVP",
        )

        preview = self.service.preview_portfolio_import(
            {
                "sourceType": "tcgplayer_csv_v1",
                "fileName": "tcgplayer.csv",
                "csvText": "\n".join(
                    [
                        "Collection Name,Product Name,Set Name,Set Code,Number,Language,Condition,Quantity,Market Price,Variant",
                        "Case A,Charizard ex,Obsidian Flames,OBF,223/197,English,Near Mint,2,54.12,Raw",
                        "Case A,Charizard ex,,,,English,Near Mint,1,12.00,Raw",
                        "Case A,Missingno,Glitch Set,GLT,999/999,English,Near Mint,1,1.00,Raw",
                        "Case A,Charizard ex,Obsidian Flames,OBF,223/197,English,Near Mint,0,54.12,Raw",
                        "Case A,Charizard ex,Obsidian Flames,OBF,223/197,English,Near Mint,1,54.12,Slab",
                    ]
                ),
            }
        )

        self.assertEqual(preview["summary"]["rowCount"], 5)
        self.assertEqual(preview["summary"]["matchedCount"], 1)
        self.assertEqual(preview["summary"]["ambiguousCount"], 1)
        self.assertEqual(preview["summary"]["unresolvedCount"], 1)
        self.assertEqual(preview["summary"]["unsupportedCount"], 1)
        self.assertEqual(preview["summary"]["skippedCount"], 1)
        self.assertEqual(preview["summary"]["readyCount"], 1)

        matched_row = preview["rows"][0]
        self.assertEqual(matched_row["matchStatus"], "matched")
        self.assertEqual(matched_row["matchStrategy"], "exact_structured")
        self.assertEqual(matched_row["matchedCardID"], "obf-charizard-ex-223")
        self.assertEqual(matched_row["commitAction"], "import_seed")
        self.assertEqual(matched_row["acquisitionUnitPrice"], None)

        ambiguous_row = preview["rows"][1]
        self.assertEqual(ambiguous_row["matchStatus"], "ambiguous")
        self.assertGreaterEqual(len(ambiguous_row["candidateCardIDs"]), 2)

        unresolved_row = preview["rows"][2]
        self.assertEqual(unresolved_row["matchStatus"], "unresolved")

        skipped_row = preview["rows"][3]
        self.assertEqual(skipped_row["matchStatus"], "skipped")

        unsupported_row = preview["rows"][4]
        self.assertEqual(unsupported_row["matchStatus"], "unsupported")

    def test_preview_uses_tcgplayer_external_ref_crosswalk(self) -> None:
        self._insert_card(
            card_id="base-pikachu-58",
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            set_code="BS",
        )
        self.service.connection.execute(
            """
            INSERT INTO card_external_refs (
                provider, external_id, card_id, metadata_json, created_at, updated_at
            )
            VALUES ('tcgplayer', '123456', 'base-pikachu-58', '{}', '2026-04-20T00:00:00Z', '2026-04-20T00:00:00Z')
            """
        )
        self.service.connection.commit()

        preview = self.service.preview_portfolio_import(
            {
                "sourceType": "tcgplayer_csv_v1",
                "fileName": "tcgplayer.csv",
                "csvText": "\n".join(
                    [
                        "Collection Name,Product ID,Quantity,Condition",
                        "Case A,123456,3,Near Mint",
                    ]
                ),
            }
        )

        row = preview["rows"][0]
        self.assertEqual(row["matchStatus"], "matched")
        self.assertEqual(row["matchStrategy"], "external_ref:tcgplayer")
        self.assertEqual(row["matchedCardID"], "base-pikachu-58")

    def test_resolve_ambiguous_row_then_commit_import_buy(self) -> None:
        self._insert_card(
            card_id="obf-charizard-ex-223",
            name="Charizard ex",
            set_name="Obsidian Flames",
            number="223/197",
            set_code="OBF",
        )
        self._insert_card(
            card_id="svp-charizard-ex-074",
            name="Charizard ex",
            set_name="Scarlet & Violet Promo",
            number="074/SV-P",
            set_code="SVP",
        )

        preview = self.service.preview_portfolio_import(
            {
                "sourceType": "tcgplayer_csv_v1",
                "fileName": "tcgplayer.csv",
                "csvText": "\n".join(
                    [
                        "Collection Name,Product Name,Quantity,Condition",
                        "Case A,Charizard ex,1,Near Mint",
                    ]
                ),
            }
        )
        job_id = preview["jobID"]
        row_id = preview["rows"][0]["rowID"]
        self.assertEqual(preview["rows"][0]["matchStatus"], "ambiguous")

        resolved = self.service.resolve_portfolio_import(
            job_id,
            {
                "rows": [
                    {
                        "rowID": row_id,
                        "cardID": "obf-charizard-ex-223",
                        "acquisitionUnitPrice": 5.0,
                        "currencyCode": "USD",
                    }
                ]
            },
        )
        self.assertEqual(resolved["updatedRows"][0]["matchStatus"], "matched")
        self.assertEqual(resolved["updatedRows"][0]["commitAction"], "import_buy")

        commit = self.service.commit_portfolio_import(job_id)
        self.assertEqual(commit["summary"]["committedCount"], 1)
        self.assertEqual(len(commit["failedRows"]), 0)

        deck_row = self.service.connection.execute(
            """
            SELECT quantity, cost_basis_total, cost_basis_currency_code
            FROM deck_entries
            WHERE id = ?
            LIMIT 1
            """,
            ("raw|obf-charizard-ex-223",),
        ).fetchone()
        self.assertIsNotNone(deck_row)
        assert deck_row is not None
        self.assertEqual(deck_row["quantity"], 1)
        self.assertEqual(deck_row["cost_basis_total"], 5.0)
        self.assertEqual(deck_row["cost_basis_currency_code"], "USD")

        event_row = self.service.connection.execute(
            """
            SELECT event_kind, unit_price
            FROM deck_entry_events
            WHERE deck_entry_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            ("raw|obf-charizard-ex-223",),
        ).fetchone()
        self.assertIsNotNone(event_row)
        assert event_row is not None
        self.assertEqual(event_row["event_kind"], "import_buy")
        self.assertEqual(event_row["unit_price"], 5.0)

    def test_collectr_commit_uses_import_seed_and_keeps_market_price_out_of_cost_basis(self) -> None:
        self._insert_card(
            card_id="base-pikachu-58",
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            set_code="BS",
        )

        preview = self.service.preview_portfolio_import(
            {
                "sourceType": "collectr_csv_v1",
                "fileName": "collectr.csv",
                "csvText": "\n".join(
                    [
                        "Collection,Name,Set,Number,Language,Condition,Quantity,Market Price",
                        "Binder A,Pikachu,Base Set,58/102,English,Near Mint,2,25.00",
                        "Binder A,Unknown Card,Glitch Set,999/999,English,Near Mint,1,1.00",
                    ]
                ),
            }
        )
        job_id = preview["jobID"]
        self.assertGreaterEqual(len(preview["warnings"]), 1)
        self.assertEqual(preview["summary"]["matchedCount"], 1)
        self.assertEqual(preview["summary"]["unresolvedCount"], 1)
        self.assertEqual(preview["rows"][0]["commitAction"], "import_seed")

        commit = self.service.commit_portfolio_import(job_id)
        self.assertEqual(commit["summary"]["committedCount"], 1)
        self.assertEqual(commit["summary"]["unresolvedCount"], 1)

        deck_row = self.service.connection.execute(
            """
            SELECT quantity, cost_basis_total, cost_basis_currency_code
            FROM deck_entries
            WHERE id = ?
            LIMIT 1
            """,
            ("raw|base-pikachu-58",),
        ).fetchone()
        self.assertIsNotNone(deck_row)
        assert deck_row is not None
        self.assertEqual(deck_row["quantity"], 2)
        self.assertEqual(deck_row["cost_basis_total"], 0.0)
        self.assertIsNone(deck_row["cost_basis_currency_code"])

        event_row = self.service.connection.execute(
            """
            SELECT event_kind, unit_price, total_price
            FROM deck_entry_events
            WHERE deck_entry_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            ("raw|base-pikachu-58",),
        ).fetchone()
        self.assertIsNotNone(event_row)
        assert event_row is not None
        self.assertEqual(event_row["event_kind"], "import_seed")
        self.assertIsNone(event_row["unit_price"])
        self.assertIsNone(event_row["total_price"])

    def test_import_job_get_route_returns_filtered_rows(self) -> None:
        self._insert_card(
            card_id="base-pikachu-58",
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            set_code="BS",
        )
        preview = self.service.preview_portfolio_import(
            {
                "sourceType": "tcgplayer_csv_v1",
                "fileName": "tcgplayer.csv",
                "csvText": "\n".join(
                    [
                        "Collection Name,Product Name,Set Name,Set Code,Number,Language,Condition,Quantity",
                        "Case A,Pikachu,Base Set,BS,58/102,English,Near Mint,1",
                        "Case A,Unknown Card,Glitch Set,GLT,999/999,English,Near Mint,1",
                    ]
                ),
            }
        )

        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = f"/api/v1/portfolio/imports/{preview['jobID']}?filter=ready_to_commit&limit=10"
        handler.service = self.service
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        response_payload = captured["payload"]
        assert isinstance(response_payload, dict)
        self.assertEqual(response_payload["filter"], "ready_to_commit")
        self.assertEqual(response_payload["filteredCount"], 1)
        self.assertEqual(len(response_payload["rows"]), 1)
        self.assertEqual(response_payload["rows"][0]["matchedCardID"], "base-pikachu-58")


if __name__ == "__main__":
    unittest.main()
