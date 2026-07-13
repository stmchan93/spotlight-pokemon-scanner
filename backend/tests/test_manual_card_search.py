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

from catalog_tools import apply_schema, connect, search_cards, upsert_catalog_card  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    language: str = "English",
    set_ptcgo_code: str | None = None,
    source_provider: str = "scrydex",
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Rare",
        "variant": "Raw",
        "language": language,
        "source": source_provider,
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": set_ptcgo_code or set_id.upper(),
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


class ManualCardSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "manual-card-search.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

        seed_cards = [
            catalog_card(
                card_id="base-charizard-4",
                name="Charizard",
                set_name="Base Set",
                number="4/102",
                set_id="base1",
            ),
            catalog_card(
                card_id="base-charizard-5",
                name="Charizard",
                set_name="Base Set",
                number="5/102",
                set_id="base1",
            ),
            catalog_card(
                card_id="obf-charizard",
                name="Charizard ex",
                set_name="Obsidian Flames",
                number="223/197",
                set_id="obf",
            ),
            catalog_card(
                card_id="tcgp-charizard",
                name="Charizard",
                set_name="TCGP Digital",
                number="4/102",
                set_id="tcgp-digital",
            ),
            catalog_card(
                card_id="perfect-order-rattata-60",
                name="Rattata",
                set_name="Perfect Order",
                number="060/088",
                set_id="me3",
                set_ptcgo_code="POR",
            ),
            catalog_card(
                card_id="phantom-gate-florges-60",
                name="Florges-EX",
                set_name="Phantom Gate",
                number="060/088",
                set_id="xy4_ja",
                language="Japanese",
                set_ptcgo_code="XY4",
            ),
            catalog_card(
                card_id="scarlet-violet-aegislash-60",
                name="Aegislash",
                set_name="Scarlet & Violet Black Star Promos",
                number="060",
                set_id="svp",
                set_ptcgo_code="PR-SV",
            ),
            catalog_card(
                card_id="scarlet-violet-pikachu-88",
                name="Pikachu",
                set_name="Scarlet & Violet Black Star Promos",
                number="088",
                set_id="svp",
                set_ptcgo_code="PR-SV",
            ),
        ]

        # Seed > 100 same-name prints so the limit clamp (cap 100) is exercised.
        for index in range(1, 121):
            seed_cards.append(
                catalog_card(
                    card_id=f"pikachu-{index:03d}",
                    name=f"Pikachu {index:03d}",
                    set_name="Promo Pack",
                    number=f"{index}/120",
                    set_id="svp",
                )
            )

        for card in seed_cards:
            upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-04-20T12:00:00Z", refresh_embeddings=False)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_search_returns_backward_compatible_payload_and_prefers_exact_name(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        payload = service.search("charizard", limit=10)

        self.assertIn("results", payload)
        self.assertLessEqual(len(payload["results"]), 10)
        self.assertGreater(len(payload["results"]), 0)
        self.assertEqual(payload["results"][0]["id"], "base-charizard-4")

    def test_artist_search_paginates_through_all_matches_without_overlap(self) -> None:
        # All 128 seeded cards share artist "Test Artist"; searching that artist
        # must page through ALL of them — including late-alphabet cards the old
        # ~100 result cap silently truncated (the Kagemaru → Sudowoodo bug).
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        page_size = 30
        seen_ids: list[str] = []
        offset = 0
        pages = 0
        while True:
            payload = service.search("test", limit=page_size, offset=offset)
            self.assertIn("hasMore", payload)
            results = payload["results"]
            self.assertLessEqual(len(results), page_size)
            seen_ids.extend(str(card["id"]) for card in results)
            pages += 1
            if not payload["hasMore"]:
                break
            offset += page_size
            self.assertLess(pages, 20)  # safety: must terminate

        # No card appears on two pages, and every "Test Artist" card is reachable.
        self.assertEqual(len(seen_ids), len(set(seen_ids)), "pages overlapped")
        self.assertGreaterEqual(len(seen_ids), 128)
        # A late-alphabet card past the old 100 cap now surfaces via pagination.
        self.assertIn("pikachu-120", seen_ids)

    def test_search_hasMore_false_on_last_page_of_small_result_set(self) -> None:
        # "charizard" matches only a handful of cards → single page, hasMore False.
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = service.search("charizard", limit=30, offset=0)
        self.assertFalse(payload["hasMore"])
        self.assertGreater(len(payload["results"]), 0)

    def test_search_prefers_set_match_for_multitoken_queries(self) -> None:
        results = search_cards(self.connection, "base set charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")

    def test_search_prefers_exact_number_match_for_number_queries(self) -> None:
        results = search_cards(self.connection, "charizard 4/102", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")

    def test_search_prefers_name_match_over_number_only_match(self) -> None:
        # A real name + a mis-read number must still surface the named card, not
        # unrelated cards that merely share the number (regression: a blurry
        # "Cinccino 026/049" returned Kirlia/Tapu Lele instead of Cinccino).
        results = search_cards(self.connection, "charizard 060/088", limit=10)
        self.assertGreater(len(results), 0)
        self.assertIn("Charizard", results[0]["name"])

        number_only_ids = {
            "perfect-order-rattata-60",
            "phantom-gate-florges-60",
            "scarlet-violet-aegislash-60",
        }
        charizard_idxs = [i for i, r in enumerate(results) if "Charizard" in r["name"]]
        number_only_idxs = [i for i, r in enumerate(results) if r["id"] in number_only_ids]
        if number_only_idxs:
            self.assertLess(max(charizard_idxs), min(number_only_idxs))

    def test_search_finds_buried_promo_by_name_and_set_or_code(self) -> None:
        # A common name with more prints than the per-phrase retrieval cap used
        # to hide later-synced prints (e.g. Japanese SM-P promos): they never
        # became candidates, so name + set / name + promo-code couldn't surface
        # them. Bury one target Snorlax behind 130 same-name filler prints, then
        # confirm it's findable by set words and by the printed promo code.
        for index in range(1, 131):
            upsert_catalog_card(
                self.connection,
                catalog_card(
                    card_id=f"filler-snorlax-{index:03d}",
                    name="Snorlax",
                    set_name="Filler Set",
                    number=f"{index}/130",
                    set_id="filler",
                ),
                REPO_ROOT,
                "2026-04-20T12:00:00Z",
                refresh_embeddings=False,
            )
        upsert_catalog_card(
            self.connection,
            catalog_card(
                card_id="smp-snorlax-168",
                name="Snorlax",
                set_name="Sun & Moon Promos",
                number="168/SM-P",
                set_id="smp_ja",
                language="Japanese",
                set_ptcgo_code="",
            ),
            REPO_ROOT,
            "2026-04-20T12:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()

        def ids(query: str) -> set[str]:
            return {row["id"] for row in search_cards(self.connection, query, limit=15)}

        # Name + set name words, and name + the printed promo code, both surface
        # the buried promo print.
        self.assertIn("smp-snorlax-168", ids("snorlax sun moon promos"))
        self.assertIn("smp-snorlax-168", ids("snorlax sm-p"))
        # Single-name search keeps returning Snorlax prints (behavior unchanged).
        self.assertTrue(
            any(rid.endswith("snorlax-168") or "snorlax" in rid for rid in ids("snorlax"))
        )

    def test_search_matches_uppercase_promo_collector_numbers_case_insensitively(self) -> None:
        # Promo collector numbers are stored uppercase in the catalog
        # ("SWSH039", "096/XY-P"), but the query is canonicalized to lowercase.
        # SQLite's default collation is case-sensitive, so "swsh039" / "096/xy-p"
        # used to match nothing even though the card exists and is findable by
        # name. The number-retrieval clauses now compare COLLATE NOCASE.
        promos = [
            catalog_card(
                card_id="swshp-pikachu-039",
                name="Pikachu",
                set_name="SWSH Black Star Promos",
                number="SWSH039",
                set_id="swshp",
                set_ptcgo_code="",
            ),
            catalog_card(
                card_id="xyp-warm-pikachu-96",
                name="Warm Pikachu",
                set_name="XY Promos",
                number="096/XY-P",
                set_id="xyp_ja",
                language="Japanese",
                set_ptcgo_code="",
            ),
        ]
        for card in promos:
            upsert_catalog_card(
                self.connection, card, REPO_ROOT, "2026-04-20T12:00:00Z", refresh_embeddings=False
            )
        self.connection.commit()

        def top_ids(query: str) -> list[str]:
            return [row["id"] for row in search_cards(self.connection, query, limit=10)]

        # No-slash alphanumeric promo code (regression: SWSH039).
        self.assertEqual(top_ids("swsh039")[0], "swshp-pikachu-039")
        # Uppercase input resolves identically.
        self.assertEqual(top_ids("SWSH039")[0], "swshp-pikachu-039")
        # Slash promo code with letters on the right (regression: 096/XY-P).
        self.assertEqual(top_ids("096/xy-p")[0], "xyp-warm-pikachu-96")
        self.assertEqual(top_ids("096/XY-P")[0], "xyp-warm-pikachu-96")

    def test_search_supports_structured_name_queries(self) -> None:
        results = search_cards(self.connection, "name:charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")

    def test_search_supports_structured_set_queries(self) -> None:
        results = search_cards(self.connection, 'set:"base set"', limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")
        self.assertTrue(all(result["setName"] == "Base Set" for result in results[:3]))

    def test_search_supports_quoted_structured_name_queries(self) -> None:
        results = search_cards(self.connection, 'name:"charizard ex"', limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "obf-charizard")

    def test_search_supports_structured_number_queries(self) -> None:
        results = search_cards(self.connection, "number:4/102", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")
        self.assertEqual(results[0]["number"], "4/102")

    def test_search_preserves_slash_collector_number_queries(self) -> None:
        results = search_cards(self.connection, "060/088", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "perfect-order-rattata-60")
        self.assertEqual(results[0]["number"], "060/088")
        self.assertNotIn("scarlet-violet-aegislash-60", [result["id"] for result in results[:2]])

    def test_search_preserves_structured_slash_collector_number_queries(self) -> None:
        results = search_cards(self.connection, "number:060/088", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "perfect-order-rattata-60")
        self.assertTrue(all(result["number"] == "060/088" for result in results))

    def test_search_supports_combined_structured_and_free_text_queries(self) -> None:
        results = search_cards(self.connection, "set:obf charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "obf-charizard")

    def test_search_deprioritizes_tcgp_digital_entries(self) -> None:
        results = search_cards(self.connection, "charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertNotEqual(results[0]["id"], "tcgp-charizard")

    def test_search_clamps_limit_and_stays_off_full_table_scan(self) -> None:
        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        try:
            default_results = search_cards(self.connection, "pikachu")
            limited_results = search_cards(self.connection, "pikachu", limit=999)
        finally:
            self.connection.set_trace_callback(None)

        normalized_statements = [
            " ".join(statement.lower().split())
            for statement in statements
        ]

        self.assertEqual(len(default_results), 20)
        self.assertEqual(len(limited_results), 100)
        self.assertEqual(default_results[0]["name"].startswith("Pikachu"), True)
        self.assertFalse(
            any(
                statement.startswith("select * from cards")
                and " where " not in statement
                for statement in normalized_statements
            )
        )

    def test_search_route_keeps_backward_compatible_results_payload(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/search?q=charizard&limit=7"
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
        self.assertIn("results", captured["payload"])
        self.assertLessEqual(len(captured["payload"]["results"]), 7)
        self.assertGreater(len(captured["payload"]["results"]), 0)


class ArtistSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "artist-search.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _seed(self, *, card_id: str, name: str, artist: str, number: str, set_id: str = "art") -> None:
        card = catalog_card(
            card_id=card_id,
            name=name,
            set_name="Art Set",
            number=number,
            set_id=set_id,
        )
        card["artist"] = artist
        upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-04-20T12:00:00Z", refresh_embeddings=False)
        self.connection.commit()

    def _ids(self, query: str) -> list[str]:
        return [row["id"] for row in search_cards(self.connection, query, limit=10)]

    def test_matches_by_artist_surname_token(self) -> None:
        # Typing one token of a multi-word artist finds the card.
        self._seed(card_id="art-snorlax", name="Snorlax", artist="Ken Sugimori", number="010/100")
        self.assertIn("art-snorlax", self._ids("sugimori"))

    def test_matches_by_full_artist_name(self) -> None:
        self._seed(card_id="art-snorlax", name="Snorlax", artist="Ken Sugimori", number="010/100")
        self.assertIn("art-snorlax", self._ids("ken sugimori"))

    def test_name_match_ranks_above_artist_match(self) -> None:
        # A card NAMED "Hoshi" must outrank a card merely ILLUSTRATED by "Hoshi".
        self._seed(card_id="named-hoshi", name="Hoshi", artist="Some Artist", number="011/100")
        self._seed(card_id="art-hoshi", name="Bulbasaur", artist="Hoshi", number="012/100")
        ids = self._ids("hoshi")
        self.assertIn("named-hoshi", ids)
        self.assertIn("art-hoshi", ids)
        self.assertLess(ids.index("named-hoshi"), ids.index("art-hoshi"))

    def test_backfill_repopulates_artist_aliases(self) -> None:
        from catalog_tools import _backfill_missing_card_artist_aliases

        self._seed(card_id="art-eevee", name="Eevee", artist="Mitsuhiro Arita", number="013/100")
        # Simulate a pre-feature row whose artist aliases were never built.
        self.connection.execute("DELETE FROM card_artist_aliases WHERE card_id = ?", ("art-eevee",))
        self.connection.commit()
        self.assertNotIn("art-eevee", self._ids("arita"))

        _backfill_missing_card_artist_aliases(self.connection)
        self.connection.commit()
        self.assertIn("art-eevee", self._ids("arita"))


if __name__ == "__main__":
    unittest.main()
