from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class CardLanguageLinkTests(unittest.TestCase):
    """The card-detail payload exposes the EN↔JP counterpart (driving the PDP
    language toggle) from card_language_links, and reports nulls when unlinked."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "card-lang.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self._insert_card(card_id="en-charizard", name="Charizard", language="English")
        self._insert_card(card_id="jp-charizard", name="Charizard", language="Japanese")
        self._insert_card(card_id="en-lonely", name="Lonely Promo", language="English")

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _insert_card(self, *, card_id: str, name: str, language: str) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Base Set" if language == "English" else "第1弾",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language=language,
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="base1" if language == "English" else "base1_ja",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _link(self, card_id: str, counterpart_card_id: str, counterpart_language: str) -> None:
        self.service.connection.execute(
            """
            INSERT INTO card_language_links
                (card_id, counterpart_card_id, counterpart_language, match_score, match_method, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (card_id, counterpart_card_id, counterpart_language, 0.97, "art_embedding", utc_now()),
        )
        self.service.connection.commit()

    def _detail(self, card_id: str) -> dict:
        with self.service.request_identity_context(RequestIdentity(user_id="user-a", auth_source="test")):
            detail = self.service.card_detail(card_id)
        assert detail is not None
        return detail

    def test_counterpart_exposed_both_directions(self) -> None:
        self._link("en-charizard", "jp-charizard", "Japanese")
        self._link("jp-charizard", "en-charizard", "English")

        en = self._detail("en-charizard")
        self.assertEqual(en["language"], "English")
        self.assertEqual(en["counterpartCardID"], "jp-charizard")
        self.assertEqual(en["counterpartLanguage"], "Japanese")

        jp = self._detail("jp-charizard")
        self.assertEqual(jp["language"], "Japanese")
        self.assertEqual(jp["counterpartCardID"], "en-charizard")
        self.assertEqual(jp["counterpartLanguage"], "English")

    def test_unlinked_card_reports_null_counterpart(self) -> None:
        detail = self._detail("en-lonely")
        self.assertEqual(detail["language"], "English")
        self.assertIsNone(detail["counterpartCardID"])
        self.assertIsNone(detail["counterpartLanguage"])


if __name__ == "__main__":
    unittest.main()
