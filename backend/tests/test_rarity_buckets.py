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

from catalog_tools import (
    GAME_POKEMON,  # noqa: E402
    RARITY_BUCKET_KEYS,
    apply_schema,
    card_by_id,
    connect,
    rarity_bucket,
    search_cards,
    upsert_catalog_card,
)
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


# Ground-truth exact labels (extracted from the live catalog DB) → bucket.
# This is the drift tripwire: every label the feature was specced against must
# keep mapping to its specified bucket.
EXACT_LABEL_BUCKETS = {
    # sir
    "Special Illustration Rare": "sir",
    "Special Art Rare": "sir",
    "2 Star": "sir",
    # illustration
    "Illustration Rare": "illustration",
    "Art Rare": "illustration",
    "Trainer Gallery Rare Holo": "illustration",
    "Character Rare": "illustration",
    "Character Super Rare": "illustration",
    # ultra
    "Rare Ultra": "ultra",
    "Ultra Rare": "ultra",
    "Super Rare": "ultra",
    "Rare Holo EX": "ultra",
    "Rare Holo ex": "ultra",
    "Rare Holo GX": "ultra",
    "Rare Holo V": "ultra",
    "Rare Holo VMAX": "ultra",
    "Rare Holo VSTAR": "ultra",
    "Rare Holo LV.X": "ultra",
    "Mega Ultra Rare": "ultra",
    "Mega Attack Rare": "ultra",
    "Amazing Rare": "ultra",
    "LEGEND": "ultra",
    "1 Star": "ultra",
    # secret
    "Rare Secret": "secret",
    "Secret Rare": "secret",
    "Hyper Rare": "secret",
    "Rare Rainbow": "secret",
    "Mega Hyper Rare": "secret",
    "Black White Rare": "secret",
    "Crown": "secret",
    "3 Star": "secret",
    # shiny
    "Rare Shiny": "shiny",
    "Shiny Rare": "shiny",
    "Shiny Ultra Rare": "shiny",
    "Rare Shiny GX": "shiny",
    "Shiny Super Rare": "shiny",
    "Rare Shining": "shiny",
    "Radiant Rare": "shiny",
    "Rare Holo Star": "shiny",
    "Rare Holo ☆": "shiny",
    # promo
    "Promo": "promo",
    "Pocket Promo": "promo",
    # standard
    "Common": "standard",
    "Uncommon": "standard",
    "Rare": "standard",
    "Rare Holo": "standard",
    "Double Rare": "standard",
    "Triple Rare": "standard",
    "1 Diamond": "standard",
    "2 Diamond": "standard",
    "3 Diamond": "standard",
    "4 Diamond": "standard",
    "ACE SPEC Rare": "standard",
    "ACE SPEC": "standard",
    "Rare ACE": "standard",
    "Rare Prism Star": "standard",
    "Prism Rare": "standard",
    "Rare BREAK": "standard",
    "Rare Prime": "standard",
    "Classic Collection": "standard",
    # other
    "Unknown": "other",
    "None": "other",
}


class RarityBucketUnitTests(unittest.TestCase):
    def test_bucket_keys_constant_is_complete(self) -> None:
        self.assertEqual(
            RARITY_BUCKET_KEYS,
            ("sir", "illustration", "ultra", "secret", "shiny", "promo", "standard", "other"),
        )

    def test_en_jp_label_pairs_share_a_bucket(self) -> None:
        # EN "Special Illustration Rare" and JP "Special Art Rare" are the same
        # tier; likewise Illustration/Art Rare and Hyper/Rainbow tier.
        self.assertEqual(rarity_bucket("Special Illustration Rare"), "sir")
        self.assertEqual(rarity_bucket("Special Art Rare"), "sir")
        self.assertEqual(rarity_bucket("Illustration Rare"), "illustration")
        self.assertEqual(rarity_bucket("Art Rare"), "illustration")
        self.assertEqual(rarity_bucket("Hyper Rare"), "secret")
        self.assertEqual(rarity_bucket("Rare Secret"), "secret")

    def test_case_and_whitespace_insensitive(self) -> None:
        self.assertEqual(rarity_bucket("  special   illustration   rare  "), "sir")
        self.assertEqual(rarity_bucket("SPECIAL ILLUSTRATION RARE"), "sir")
        self.assertEqual(rarity_bucket("rare holo gx"), "ultra")
        self.assertEqual(rarity_bucket("\tPromo\n"), "promo")

    def test_none_empty_unknown_and_garbage_map_to_other(self) -> None:
        self.assertEqual(rarity_bucket(None), "other")
        self.assertEqual(rarity_bucket(""), "other")
        self.assertEqual(rarity_bucket("   "), "other")
        self.assertEqual(rarity_bucket("Unknown"), "other")
        self.assertEqual(rarity_bucket("None"), "other")
        self.assertEqual(rarity_bucket("Totally Made Up Tier"), "other")
        # Non-string input must never raise.
        self.assertEqual(rarity_bucket(42), "other")
        self.assertEqual(rarity_bucket(["Rare"]), "other")

    def test_substring_fallback_for_unseen_labels(self) -> None:
        # Not exact catalog labels — must resolve via the ordered fallback.
        self.assertEqual(rarity_bucket("Super Special Art Rare Deluxe"), "sir")
        self.assertEqual(rarity_bucket("Mega Special Illustration Rare"), "sir")
        self.assertEqual(rarity_bucket("Trainer Gallery Something"), "illustration")
        self.assertEqual(rarity_bucket("Rare Shiny VMAX"), "shiny")
        self.assertEqual(rarity_bucket("Rare Radiant Holo"), "shiny")
        # "secret" outranks "ultra" in the fallback chain.
        self.assertEqual(rarity_bucket("Ultra Secret Rare"), "secret")
        self.assertEqual(rarity_bucket("Rainbow Rare"), "secret")
        self.assertEqual(rarity_bucket("New Promo Thing"), "promo")
        self.assertEqual(rarity_bucket("Full Art Trainer"), "ultra")
        self.assertEqual(rarity_bucket("Rare Ultra Holo"), "ultra")
        self.assertEqual(rarity_bucket("5 Diamond"), "standard")

    def test_substring_fallback_order_shiny_before_secret_and_ultra(self) -> None:
        # "shiny" outranks both "secret" and "ultra" in the fallback chain.
        self.assertEqual(rarity_bucket("Shiny Secret Something"), "shiny")
        self.assertEqual(rarity_bucket("Shiny Ultra Something"), "shiny")


class RarityBucketCoverageTests(unittest.TestCase):
    def test_every_known_catalog_label_maps_to_its_specified_bucket(self) -> None:
        for label, expected_bucket in EXACT_LABEL_BUCKETS.items():
            self.assertEqual(
                rarity_bucket(label),
                expected_bucket,
                msg=f"rarity label {label!r} drifted out of bucket {expected_bucket!r}",
            )


def catalog_card(
    *,
    card_id: str,
    name: str,
    rarity: str,
    set_name: str = "Test Set",
    number: str = "001/100",
    set_id: str = "tst",
    language: str = "English",
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": rarity,
        "variant": "Raw",
        "language": language,
        "source": "scrydex",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": "2024-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": [],
        "artist": "Test Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "reference_image_url": f"https://images.example/{card_id}.png",
        "reference_image_small_url": f"https://images.example/{card_id}-small.png",
        "source_payload": {"name": name},
        "tcgplayer": {},
        "cardmarket": {},
    }


class RaritySearchFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "rarity-search.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

        seed_cards = [
            catalog_card(
                card_id="umbreon-sir",
                name="Umbreon ex",
                rarity="Special Illustration Rare",
                number="161/131",
            ),
            catalog_card(
                card_id="umbreon-sar-jp",
                name="Umbreon VMAX",
                rarity="Special Art Rare",
                number="095/069",
                language="Japanese",
            ),
            catalog_card(
                card_id="umbreon-common",
                name="Umbreon",
                rarity="Common",
                number="060/100",
            ),
            catalog_card(
                card_id="umbreon-ultra",
                name="Umbreon V",
                rarity="Rare Ultra",
                number="188/203",
            ),
            catalog_card(
                card_id="shinx-common",
                name="Shinx",
                rarity="Common",
                number="043/100",
            ),
            catalog_card(
                card_id="zacian-shiny",
                name="Zacian",
                rarity="Rare Shiny",
                number="SV110/SV122",
            ),
        ]
        for card in seed_cards:
            upsert_catalog_card(
                self.connection, card, REPO_ROOT, "2026-07-16T12:00:00Z", refresh_embeddings=False
            )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _ids(self, query: str, **kwargs) -> set[str]:
        return {row["id"] for row in search_cards(self.connection, query, limit=20, **kwargs, game=GAME_POKEMON)}

    def test_structured_rarity_token_narrows_results(self) -> None:
        ids = self._ids("rarity:sir umbreon")
        self.assertEqual(ids, {"umbreon-sir", "umbreon-sar-jp"})

    def test_structured_rarity_token_matches_raw_rarity_substring(self) -> None:
        # A non-bucket value still works as a case-insensitive substring of the
        # raw rarity label.
        ids = self._ids('rarity:"special illustration" umbreon')
        self.assertEqual(ids, {"umbreon-sir"})

    def test_free_text_sir_alias_narrows_and_strips_name_term(self) -> None:
        ids = self._ids("sir umbreon")
        self.assertEqual(ids, {"umbreon-sir", "umbreon-sar-jp"})

    def test_free_text_multiword_alias(self) -> None:
        ids = self._ids("ultra rare umbreon")
        self.assertEqual(ids, {"umbreon-ultra"})

    def test_longest_alias_phrase_wins(self) -> None:
        # "special illustration rare" must resolve to sir, not strand
        # "special" as a name term with the shorter "illustration rare" alias.
        ids = self._ids("special illustration rare umbreon")
        self.assertEqual(ids, {"umbreon-sir", "umbreon-sar-jp"})

    def test_bare_shinx_does_not_trigger_shiny_alias(self) -> None:
        ids = self._ids("shinx")
        self.assertIn("shinx-common", ids)
        self.assertNotIn("zacian-shiny", ids)

    def test_bare_rarity_alias_browses_bucket(self) -> None:
        # "shiny" alone = rarity-only browse of the shiny bucket.
        ids = self._ids("shiny")
        self.assertEqual(ids, {"zacian-shiny"})

    def test_bare_structured_rarity_token_browses_bucket(self) -> None:
        ids = self._ids("rarity:sir")
        self.assertEqual(ids, {"umbreon-sir", "umbreon-sar-jp"})

    def test_rarity_bucket_filter_param_applies_without_query_tokens(self) -> None:
        ids = self._ids("umbreon", rarity_bucket_filter="sir")
        self.assertEqual(ids, {"umbreon-sir", "umbreon-sar-jp"})

    def test_rarity_bucket_filter_param_alone_browses(self) -> None:
        ids = self._ids("", rarity_bucket_filter="ultra")
        self.assertEqual(ids, {"umbreon-ultra"})

    def test_rarity_browse_respects_limit_and_offset(self) -> None:
        page_one = search_cards(self.connection, "rarity:standard", limit=1, offset=0, game=GAME_POKEMON)
        page_two = search_cards(self.connection, "rarity:standard", limit=1, offset=1, game=GAME_POKEMON)
        self.assertEqual(len(page_one), 1)
        self.assertEqual(len(page_two), 1)
        self.assertNotEqual(page_one[0]["id"], page_two[0]["id"])

    def test_search_route_rarity_bucket_param_filters(self) -> None:
        captured = self._route_payload("/api/v1/cards/search?q=umbreon&rarityBucket=sir")
        result_ids = {card["id"] for card in captured["payload"]["results"]}
        self.assertEqual(result_ids, {"umbreon-sir", "umbreon-sar-jp"})

    def test_search_route_ignores_invalid_rarity_bucket_param(self) -> None:
        captured = self._route_payload("/api/v1/cards/search?q=umbreon&rarityBucket=bogus")
        result_ids = {card["id"] for card in captured["payload"]["results"]}
        self.assertEqual(
            result_ids,
            {"umbreon-sir", "umbreon-sar-jp", "umbreon-common", "umbreon-ultra"},
        )

    def _route_payload(self, path: str) -> dict[str, object]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.service = SpotlightScanService(self.database_path, REPO_ROOT)
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]
        try:
            handler.do_GET()
        finally:
            handler.service.connection.close()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        return captured


class RaritySerializerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "rarity-serializer.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_catalog_card(
            self.connection,
            catalog_card(
                card_id="umbreon-sir",
                name="Umbreon ex",
                rarity="Special Illustration Rare",
                number="161/131",
            ),
            REPO_ROOT,
            "2026-07-16T12:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_card_row_to_dict_includes_rarity_bucket(self) -> None:
        card = card_by_id(self.connection, "umbreon-sir")
        self.assertIsNotNone(card)
        self.assertEqual(card["rarity"], "Special Illustration Rare")
        self.assertEqual(card["rarityBucket"], "sir")
        self.assertIn(card["rarityBucket"], RARITY_BUCKET_KEYS)

    def test_candidate_base_payload_includes_rarity_bucket(self) -> None:
        card = card_by_id(self.connection, "umbreon-sir")
        payload = SpotlightScanService._candidate_base_payload(card, card)
        self.assertEqual(payload["rarity"], "Special Illustration Rare")
        self.assertEqual(payload["rarityBucket"], "sir")
        self.assertIn(payload["rarityBucket"], RARITY_BUCKET_KEYS)

    def test_candidate_base_payload_missing_rarity_buckets_to_other(self) -> None:
        payload = SpotlightScanService._candidate_base_payload({"id": "x"}, {"id": "x"})
        self.assertEqual(payload["rarity"], "Unknown")
        self.assertEqual(payload["rarityBucket"], "other")


if __name__ == "__main__":
    unittest.main()
