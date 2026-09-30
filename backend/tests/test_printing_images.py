"""Owned copies / watched printings on an alt-art printing carry that
printing's TCGplayer image (printingImageUrl); every other row keeps the card image."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_deck_entry  # noqa: E402
import printing_images  # noqa: E402
from printing_images import is_art_version_label, printing_image_fields, printing_images_for  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import CandidateEncodingItem, PricingLoadPolicy, SpotlightScanService  # noqa: E402

CARD_ID = "onepiece~OP05-091"
ST30_ID = "onepiece~ST30-001"
ST30_ALT_ART = {
    "label": "Alt Art",
    "imageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/693257_in_1000x1000.jpg",
    "smallImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/693257_400w.jpg",
}
SAA_URL = "https://tcgplayer-cdn.tcgplayer.com/product/541670_in_1000x1000.jpg"
SAA_SMALL_URL = "https://tcgplayer-cdn.tcgplayer.com/product/541670_400w.jpg"


def _variants(*pairs: tuple[str, str]) -> list[dict]:
    return [
        {"name": name, "marketplaces": [{"name": "tcgplayer", "product_id": pid}]}
        for name, pid in pairs
    ]


def _seed_card(connection, card_id: str, variants: list[dict], *, game: str = "onepiece") -> None:
    upsert_card(
        connection, card_id=card_id, name="Rebecca", set_name="Awakening of the New Era",
        number="OP05-091", rarity="Rare", variant="Raw", language="English", game=game,
        source_provider="scrydex", source_record_id=card_id, set_id="op05",
        image_url=f"https://images.scrydex.com/onepiece/{card_id}/large",
        image_small_url=f"https://images.scrydex.com/onepiece/{card_id}/small",
        source_payload={"id": card_id, "variants": variants},
    )


class ArtVersionLabelRuleTests(unittest.TestCase):
    def test_art_version_labels(self) -> None:
        for label in (
            "Alt Art", "Special Alt Art", "Gold Special Alt Art", "Manga Alt Art",
            "Treasure Cup Alt Art", "Premium Alt Art", "Super Alt Art", "Full Art",
            "Wanted Poster", "Enchanted", "Parallel", "Alt Art Stamp", "special  alt-art",
            "Alternate Art",
        ):
            self.assertTrue(is_art_version_label(label), label)

    def test_same_art_labels_keep_the_card_image(self) -> None:
        for label in (
            None, "", "Normal", "Foil", "Holofoil", "Reverse Holofoil", "Cold Foil",
            "Textured Foil", "Jolly Roger Foil", "1st Edition Holofoil", "Unlimited",
            "Reprint", "League Stamp", "Pokemon Center Stamp", "Jumbo", "Cosmos Holofoil",
            "Jason Klaczynski",
        ):
            self.assertFalse(is_art_version_label(label), label)


class PrintingImagesLookupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "printing-images.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        self.addCleanup(self.connection.close)
        _seed_card(self.connection, CARD_ID, _variants(
            ("Foil", "528165"), ("Alt Art", "541669"), ("Special Alt Art", "541670"),
            ("Special Alt Art", "999999"),  # a later duplicate label never wins
        ))
        self.connection.commit()

    def test_alt_art_printing_resolves_its_product_image(self) -> None:
        images = printing_images_for(self.connection, [(CARD_ID, "special alt art")])
        self.assertEqual(
            printing_image_fields(images, CARD_ID, "Special Alt Art"),
            {"printingImageUrl": SAA_URL, "printingImageSmallUrl": SAA_SMALL_URL},
        )

    def test_finish_only_printing_and_unknown_label_have_no_image(self) -> None:
        images = printing_images_for(
            self.connection, [(CARD_ID, "Foil"), (CARD_ID, None), (CARD_ID, "Manga Alt Art")]
        )
        self.assertEqual(images, {})
        self.assertEqual(
            printing_image_fields(images, CARD_ID, "Foil"),
            {"printingImageUrl": None, "printingImageSmallUrl": None},
        )

    def test_tcgplayer_only_cards_are_skipped(self) -> None:
        tpo_id = "onepiece~tcgplayer-777"
        _seed_card(self.connection, tpo_id, _variants(("Alt Art", "777")))
        self.connection.commit()
        self.assertEqual(printing_images_for(self.connection, [(tpo_id, "Alt Art")]), {})

    def test_product_claimed_by_two_cards_is_skipped(self) -> None:
        _seed_card(self.connection, "onepiece~OP99-001", _variants(("Alt Art", "541669")))
        self.connection.commit()
        images = printing_images_for(
            self.connection, [(CARD_ID, "Alt Art"), (CARD_ID, "Special Alt Art")]
        )
        self.assertEqual(set(images), {(CARD_ID, "specialaltart")})

    def test_card_printing_images_list_only_art_changing_printings(self) -> None:
        _seed_card(self.connection, ST30_ID, _variants(("Foil", "693256"), ("Alt Art", "693257")))
        self.connection.commit()
        by_card = printing_images.printing_images_by_card(self.connection, [ST30_ID, CARD_ID, "nope"])
        self.assertEqual(by_card[ST30_ID], [ST30_ALT_ART])
        # Listing order; a later duplicate label never wins; Foil gets no entry.
        self.assertEqual(
            [(entry["label"], entry["imageUrl"]) for entry in by_card[CARD_ID]],
            [
                ("Alt Art", "https://tcgplayer-cdn.tcgplayer.com/product/541669_in_1000x1000.jpg"),
                ("Special Alt Art", SAA_URL),
            ],
        )
        self.assertNotIn("nope", by_card)

    def test_non_art_rows_issue_no_queries(self) -> None:
        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        self.addCleanup(self.connection.set_trace_callback, None)
        printing_images_for(self.connection, [(CARD_ID, "Foil"), ("card-2", "Holofoil")])
        self.assertEqual(statements, [])


class PrintingImagePayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "printing-image-payloads.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _seed_card(connection, CARD_ID, _variants(
            ("Foil", "528165"), ("Special Alt Art", "541670"),
        ))
        upsert_deck_entry(
            connection, owner_user_id="user-a", card_id=CARD_ID, variant_name="Special Alt Art",
            condition="NM", quantity=1, added_at="2026-09-28T10:00:00Z",
            unit_price=150.0, currency_code="USD", event_kind="buy",
        )
        upsert_deck_entry(
            connection, owner_user_id="user-a", card_id=CARD_ID, variant_name="Foil",
            condition="NM", quantity=1, added_at="2026-09-27T10:00:00Z",
        )
        connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at) "
            "VALUES ('user-a', ?, 'Special Alt Art', '2026-09-28T10:00:00Z')",
            (CARD_ID,),
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _as_user(self):
        return self.service.request_identity_context(
            RequestIdentity(user_id="user-a", auth_source="test")
        )

    def test_collection_entries_carry_the_printing_image(self) -> None:
        with self._as_user():
            entries = self.service.deck_entries(limit=10)["entries"]
        by_variant = {entry["variantName"]: entry for entry in entries}
        self.assertEqual(by_variant["Special Alt Art"]["printingImageUrl"], SAA_URL)
        self.assertEqual(by_variant["Special Alt Art"]["printingImageSmallUrl"], SAA_SMALL_URL)
        # The card image is untouched; the finish-only copy keeps it.
        self.assertIn("images.scrydex.com", by_variant["Special Alt Art"]["card"]["imageLargeURL"])
        self.assertIsNone(by_variant["Foil"]["printingImageUrl"])
        self.assertIsNone(by_variant["Foil"]["printingImageSmallUrl"])

    def test_printing_watch_carries_the_printing_image(self) -> None:
        with self._as_user():
            watchlist = self.service.card_favorites(limit=10)["entries"]
        self.assertEqual(len(watchlist), 1)
        self.assertEqual(watchlist[0]["printingImageUrl"], SAA_URL)

    def test_performance_rows_carry_the_printing_image(self) -> None:
        with self._as_user():
            rows = self.service.portfolio_performance()["rows"]
        by_variant = {row["variantName"]: row for row in rows}
        self.assertEqual(by_variant["Special Alt Art"]["printingImageSmallUrl"], SAA_SMALL_URL)
        self.assertIsNone(by_variant["Foil"]["printingImageUrl"])

    def test_ledger_buy_row_carries_the_printing_image(self) -> None:
        with self._as_user():
            ledger = self.service.portfolio_ledger(range_label="ALL")
        buys = [row for row in ledger["transactions"] if row["kind"] == "buy"]
        self.assertEqual([row["printingImageUrl"] for row in buys], [SAA_URL])

    def test_card_detail_lists_the_art_changing_printings(self) -> None:
        _seed_card(self.service.connection, ST30_ID, _variants(("Foil", "693256"), ("Alt Art", "693257")))
        self.service.connection.commit()
        detail = self.service.card_detail(ST30_ID)
        self.assertEqual(detail["printingImages"], [ST30_ALT_ART])
        # The card image stays the base art.
        self.assertIn("images.scrydex.com", detail["imageLargeURL"])

    def test_scan_candidates_carry_printing_images(self) -> None:
        _seed_card(self.service.connection, ST30_ID, _variants(("Foil", "693256"), ("Alt Art", "693257")))
        self.service.connection.commit()
        statements: list[str] = []
        self.service.connection.set_trace_callback(statements.append)
        self.addCleanup(self.service.connection.set_trace_callback, None)
        encoded, _, _ = self.service._encode_top_candidates(
            [
                CandidateEncodingItem(
                    card={"id": card_id}, image_score=0.9, collector_number_score=0.0,
                    name_score=0.0, final_score=0.9, reasons=("visual_similarity",),
                )
                for card_id in (ST30_ID, CARD_ID)
            ],
            pricing_context=self.service._raw_pricing_context(),
            pricing_policy=PricingLoadPolicy.top_ten_cached_only(),
            trigger_source="scan_match_raw",
        )
        self.assertEqual(encoded[0]["printingImages"], [ST30_ALT_ART])
        self.assertEqual([entry["label"] for entry in encoded[1]["printingImages"]], ["Special Alt Art"])
        # One batched lookup for the whole candidate list.
        lookups = [sql for sql in statements if "SELECT card_id, product_id, variant_label" in sql]
        self.assertEqual(len(lookups), 1)

    def test_lookup_is_batched(self) -> None:
        calls: list[int] = []
        original = printing_images.printing_images_for

        def counting(connection, pairs):
            calls.append(1)
            return original(connection, pairs)

        printing_images.printing_images_for = counting
        self.addCleanup(setattr, printing_images, "printing_images_for", original)
        with self._as_user():
            self.service.deck_entries(limit=10)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
