"""TCGplayer-only catalog, phase P1 (+ Pokémon P2 supertypes): with
TCGCSV_TCGPLAYER_ONLY_INGEST=on the nightly TCGCSV sync turns every missing card
into a real `cards` row in a synthetic per-group set, prices it in the same run,
and nothing about it may ever reach Scrydex.
See docs/tcgplayer-only-catalog-plan-2026-09-29.md."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock
from unittest.mock import Mock, patch

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import scrydex_adapter  # noqa: E402
from catalog_tools import (  # noqa: E402
    _manual_search_score,
    apply_schema,
    card_by_id,
    catalog_source_for_card_id,
    collision_guard,
    connect,
    get_cards_by_expansion,
    is_tcgplayer_only_card_id,
    list_persisted_expansions,
    reset_collision_guard_cache,
    search_cards,
    tokenize,
    upsert_card,
)
from raw_visual_index import RawVisualIndex, is_alt_reference_entry  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402
import sync_tcgcsv_prices  # noqa: E402
import tcgplayer_only_catalog as tpo  # noqa: E402
from visual_index_incremental import append_missing_cards, diff_missing_ids  # noqa: E402

OP_PROMO_GROUP = {"groupId": 17675, "name": "One Piece Promotion Cards", "abbreviation": "OP-PR",
                  "publishedOn": "2022-09-30T00:00:00"}
TRAINER_KIT_GROUP = {"groupId": 2194, "name": "SM Trainer Kit: Alolan Sandslash & Alolan Ninetales",
                     "publishedOn": "2017-11-03T00:00:00"}
LUFFY_ID = "onepiece~tcgplayer-552137"
LUFFY_PRICE = 75.0


def _product(product_id: int, name: str, **extended: str) -> dict:
    return {
        "productId": product_id,
        "name": name,
        "url": f"https://www.tcgplayer.com/product/{product_id}",
        "extendedData": [{"name": key.replace("_", " "), "value": value} for key, value in extended.items()],
    }


def _jpeg(width: int = 600, height: int = 838, shade: int = 10) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (shade, 20, 30)).save(buffer, "JPEG")
    return buffer.getvalue()


def _payload(product_id: int) -> dict:
    return {"variants": [{"name": "normal", "marketplaces": [
        {"name": "tcgplayer", "product_id": str(product_id)}]}]}


class IngestTestCase(unittest.TestCase):
    CRAWL = [
        # The trigger: a numberless Sealed Battle event Leader Scrydex never listed.
        (68, OP_PROMO_GROUP, _product(552137, "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)",
                                      Rarity="L", CardType="Leader")),
        # A promo already in the catalog: its product is claimed, never ingested.
        (68, OP_PROMO_GROUP, _product(450299, "Monkey.D.Luffy (Promotion Pack 2022)",
                                      Number="P-001", Rarity="PR", CardType="Leader")),
        # Unmapped Pokémon group: a Pokémon, a Trainer and an Energy.
        (3, TRAINER_KIT_GROUP, _product(150001, "Alolan Vulpix (Trainer Kit)",
                                        Rarity="Common", HP="60", Stage="Basic", Card_Type="Water")),
        (3, TRAINER_KIT_GROUP, _product(150002, "Professor Kukui (Trainer Kit)",
                                        Rarity="Uncommon", Card_Type="Trainer - Supporter")),
        (3, TRAINER_KIT_GROUP, _product(150003, "Water Energy (2)", Card_Type="Basic Water Energy")),
    ]
    PRICES = {
        "552137": {"Normal": {"productId": 552137, "subTypeName": "Normal", "marketPrice": LUFFY_PRICE,
                              "lowPrice": 60.0}},
        "150001": {"Holofoil": {"productId": 150001, "subTypeName": "Holofoil", "marketPrice": 2.5}},
        "450299": {"Normal": {"productId": 450299, "subTypeName": "Normal", "marketPrice": 3.0}},
    }

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "tpo-ingest.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        for name in ("load_tcgplayer_id_overrides", "load_tcgplayer_id_backfill"):
            patcher = mock.patch.object(sync_tcgcsv_prices, name, return_value={})
            patcher.start()
            self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"})
        env.start()
        self.addCleanup(env.stop)
        upsert_card(
            self.connection, card_id="onepiece~P-001", name="Monkey.D.Luffy", set_name="Promotion Cards",
            number="P-001", rarity="Promo", variant="Raw", language="English", game="onepiece",
            source_provider="scrydex", set_id="onepiece~P", supertype="Leader",
            source_payload=_payload(450299),
        )
        self.connection.commit()
        self.images: dict[str, bytes | None] = {}
        self.fetched: list[str] = []

    def _fetch(self, url: str) -> bytes | None:
        self.fetched.append(url)
        pid = url.rsplit("/", 1)[1].split("_", 1)[0]
        return self.images.get(pid, _jpeg(shade=int(pid) % 250))

    def _sync(self, mode: str = "on", crawl=None, prices=None, run: str = "1"):
        crawl = list(crawl if crawl is not None else self.CRAWL)
        prices = prices if prices is not None else self.PRICES

        def fake_build(categories, group_by_product=None, failed_groups=None, product_rows_out=None):
            product_rows_out.extend(crawl)
            return prices, {}

        env = {"TCGCSV_TCGPLAYER_ONLY_INGEST": mode, "TCGCSV_SEALED_INGEST": "off"}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(sync_tcgcsv_prices, "build_price_and_number_maps", side_effect=fake_build), \
                mock.patch.object(tpo, "default_fetch_image", side_effect=self._fetch):
            return sync_tcgcsv_prices.run_tcgcsv_price_sync(
                self.connection, product_price_map=None, price_date=date.today().isoformat(),
                last_updated=f"2026-09-29T20:00:00Z-{mode}-{run}", force=True,
            )

    def _status(self, product_id) -> str | None:
        row = self.connection.execute(
            "SELECT status FROM tcgplayer_product_classifications WHERE product_id = ?", (str(product_id),)
        ).fetchone()
        return row[0] if row else None


class IngestTests(IngestTestCase):
    def test_missing_cards_become_priced_rows_under_tcgplayer_ids(self):
        stats = self._sync()
        self.assertEqual(stats["tcgplayer_only_created"], 4)
        luffy = card_by_id(self.connection, LUFFY_ID)
        self.assertIsNotNone(luffy)
        self.assertEqual(luffy["name"], "Monkey.D.Luffy")
        self.assertEqual(luffy["variant"], "Sealed Battle 2024 Vol. 2")
        self.assertEqual(luffy["rarity"], "Leader")
        self.assertEqual(luffy["number"], "")
        self.assertEqual(luffy["game"], "onepiece")
        self.assertEqual(luffy["sourceProvider"], "tcgplayer")
        self.assertEqual(luffy["sourceRecordID"], "552137")
        self.assertEqual(luffy["setID"], "onepiece~tcgplayer-group-17675")
        self.assertEqual(luffy["setName"], "One Piece Promotion Cards")
        self.assertEqual(luffy["setReleaseDate"], "2022/09/30")
        self.assertEqual(luffy["catalogSource"], "tcgplayer")
        self.assertIsNone(luffy["canonicalCardId"])
        self.assertEqual(luffy["imageURL"], "https://tcgplayer-cdn.tcgplayer.com/product/552137_in_1000x1000.jpg")
        self.assertEqual(self._status(552137), tpo.STATUS_CREATED)
        # Priced by the SAME run, from TCGCSV.
        snapshot = self.connection.execute(
            "SELECT main_raw_market_price FROM card_price_snapshots WHERE card_id = ?", (LUFFY_ID,)
        ).fetchone()
        self.assertEqual(snapshot[0], LUFFY_PRICE)
        # Never the TCG Pocket prefix; the claimed promo is untouched.
        ids = [row[0] for row in self.connection.execute(
            "SELECT id FROM cards WHERE source_provider = 'tcgplayer' ORDER BY id")]
        self.assertEqual(ids, ["onepiece~tcgplayer-552137", "tcgplayer-150001", "tcgplayer-150002",
                               "tcgplayer-150003"])
        self.assertFalse(any(card_id.startswith("tcgp-") for card_id in ids))
        self.assertTrue(all(is_tcgplayer_only_card_id(card_id) for card_id in ids))
        self.assertIsNone(self._status(450299))

    def test_rerun_is_idempotent_and_keeps_probed_images(self):
        self._sync(run="1")
        first = {row[0]: tuple(row) for row in self.connection.execute(
            "SELECT id, name, set_id, image_url, image_small_url FROM cards ORDER BY id")}
        fetched = len(self.fetched)
        stats = self._sync(run="2")
        self.assertEqual(stats["tcgplayer_only_created"], 0)
        second = {row[0]: tuple(row) for row in self.connection.execute(
            "SELECT id, name, set_id, image_url, image_small_url FROM cards ORDER BY id")}
        self.assertEqual(first, second)
        self.assertEqual(len(self.fetched), fetched)  # good images are not re-probed
        self.assertEqual(self._status(552137), tpo.STATUS_CREATED)
        self.assertEqual(self.connection.execute(
            "SELECT COUNT(*) FROM expansions WHERE source_provider = 'tcgplayer'").fetchone()[0], 2)
        run = json.loads(self.connection.execute(
            "SELECT notes_json FROM provider_sync_runs ORDER BY started_at DESC LIMIT 1").fetchone()[0])
        self.assertEqual(run["tcgplayerOnlyIngest"]["refreshed"], 4)

    def test_synthetic_group_sets_are_browsable(self):
        self._sync()
        onepiece_sets = {row["id"]: row for row in list_persisted_expansions(self.connection, game="onepiece")}
        self.assertIn("onepiece~tcgplayer-group-17675", onepiece_sets)
        self.assertEqual(onepiece_sets["onepiece~tcgplayer-group-17675"]["name"], "One Piece Promotion Cards")
        self.assertEqual(onepiece_sets["onepiece~tcgplayer-group-17675"]["language"], "English")
        cards = get_cards_by_expansion(self.connection, "onepiece~tcgplayer-group-17675", game="onepiece")
        self.assertEqual([card["id"] for card in cards], [LUFFY_ID])
        pokemon_sets = {row["id"] for row in list_persisted_expansions(self.connection, game="pokemon")}
        self.assertEqual(pokemon_sets, {"tcgplayer-group-2194"})

    def test_pokemon_supertypes_are_derived_so_the_visual_refresh_indexes_them(self):
        self._sync()
        kinds = {
            row[0]: (row[1], json.loads(row[2]), json.loads(row[3]))
            for row in self.connection.execute(
                "SELECT id, supertype, subtypes_json, types_json FROM cards WHERE game = 'pokemon'")
        }
        self.assertEqual(kinds["tcgplayer-150001"], ("Pokémon", ["Basic"], ["Water"]))
        self.assertEqual(kinds["tcgplayer-150002"], ("Trainer", ["Supporter"], []))
        self.assertEqual(kinds["tcgplayer-150003"], ("Energy", ["Basic"], []))
        self.assertEqual(card_by_id(self.connection, "tcgplayer-150003")["variant"], "2")

    def test_shadow_links_are_recorded_but_not_wired_to_prices(self):
        upsert_card(
            self.connection, card_id="onepiece~OP05-060", name="Monkey.D.Luffy", set_name="OP05",
            number="OP05-060", rarity="Leader", variant="Raw", language="English", game="onepiece",
            source_provider="scrydex", set_id="onepiece~OP05", source_payload=_payload(500001),
        )
        self.connection.commit()
        event = (68, {"groupId": 24100, "name": "Awakening Release Event Cards"},
                 _product(560001, "Monkey.D.Luffy (Release Event)", Number="OP05-060", Rarity="L"))
        prices = {**self.PRICES, "560001": {"Foil": {"productId": 560001, "subTypeName": "Foil", "marketPrice": 40.0}}}
        self._sync(crawl=[*self.CRAWL, event], prices=prices)
        self.assertEqual(self._status(560001), tpo.STATUS_LINKED)
        self.assertIsNone(self.connection.execute(
            "SELECT 1 FROM card_tcgplayer_products WHERE product_id = '560001'").fetchone())
        self.assertIsNone(card_by_id(self.connection, "onepiece~tcgplayer-560001"))

    def test_rarities_map_to_scrydex_labels(self):
        self.assertEqual(tpo.scrydex_rarity("onepiece", "English", "SR"), "Super Rare")
        self.assertEqual(tpo.scrydex_rarity("onepiece", "English", "TR"), "Treasure Rare")
        self.assertEqual(tpo.scrydex_rarity("gundam", "English", "LR+"), "Legend Rare")
        self.assertEqual(tpo.scrydex_rarity("lorcana", "English", "Quest"), "Special")
        self.assertEqual(tpo.scrydex_rarity("pokemon", "English", "Holo Rare"), "Rare Holo")
        self.assertEqual(tpo.scrydex_rarity("pokemon", "Japanese", "ACE Rare"), "ACE SPEC")
        self.assertEqual(tpo.scrydex_rarity("pokemon", "English", "None"), "")
        self.assertEqual(tpo.scrydex_rarity("riftbound", "English", "Showcase"), "Showcase")

    def test_image_guard_nulls_placeholders_and_retries_them_later(self):
        placeholder = _jpeg(1000, 573)  # TCGplayer's landscape "Image Coming Soon"
        self.images = {"552137": placeholder, "150001": _jpeg(300, 419), "150002": None}
        self._sync(run="1")
        rows = {row[0]: (row[1], row[2]) for row in self.connection.execute(
            "SELECT id, image_url, image_small_url FROM cards WHERE source_provider = 'tcgplayer'")}
        self.assertEqual(rows[LUFFY_ID], (None, None))
        self.assertEqual(rows["tcgplayer-150001"],
                         (None, "https://tcgplayer-cdn.tcgplayer.com/product/150001_400w.jpg"))
        self.assertEqual(rows["tcgplayer-150002"], (None, None))
        self.assertIsNotNone(rows["tcgplayer-150003"][0])

        # Presale art arrives: the next night re-probes only the NULL rows.
        self.images = {}
        self.fetched = []
        self._sync(run="2")
        self.assertEqual(len(self.fetched), 3)
        self.assertIsNotNone(card_by_id(self.connection, LUFFY_ID)["imageURL"])

    def test_image_count_zero_is_still_probed(self):
        # TCGCSV's imageCount lags the CDN (P-116 Robin reported 0 with a live image).
        crawl = [(cat, group, {**product, "imageCount": 0}) for cat, group, product in self.CRAWL]
        self._sync(crawl=crawl)
        self.assertIsNotNone(card_by_id(self.connection, LUFFY_ID)["imageURL"])

    def test_bytes_shared_by_several_products_are_placeholders(self):
        shared = _jpeg(shade=99)
        self.images = {"150001": shared, "150002": shared, "150003": shared}
        self._sync()
        nulls = [row[0] for row in self.connection.execute(
            "SELECT id FROM cards WHERE source_provider = 'tcgplayer' AND image_url IS NULL ORDER BY id")]
        self.assertEqual(nulls, ["tcgplayer-150001", "tcgplayer-150002", "tcgplayer-150003"])

    def test_shadow_mode_still_writes_no_cards(self):
        self._sync(mode="shadow")
        self.assertEqual(self._status(552137), tpo.STATUS_SHADOW_MISSING)
        self.assertIsNone(card_by_id(self.connection, LUFFY_ID))
        self.assertEqual(self.fetched, [])

    def test_image_resolved_rows_survive_the_nightly_reclassification(self):
        self._sync(mode="shadow")
        self.connection.execute(
            "INSERT INTO tcgplayer_product_classifications (product_id, category_id, group_id, game, status, "
            "proposed_card_id, evidence_json, first_seen_at, updated_at) VALUES "
            "('570001', 68, 17675, 'onepiece', 'shadow_missing', 'onepiece~tcgplayer-570001', "
            "'{\"resolvedBy\": \"image\"}', 't0', 't0')"
        )
        self.connection.commit()
        # The rules alone say "review" for this one (P-001 is another card's number).
        twin = (68, OP_PROMO_GROUP, _product(570001, "Nami (Event)", Number="P-001",
                                             Rarity="PR", CardType="Character"))
        self._sync(crawl=[*self.CRAWL, twin], run="2")
        self.assertEqual(self._status(570001), tpo.STATUS_CREATED)
        self.assertIsNotNone(card_by_id(self.connection, "onepiece~tcgplayer-570001"))


class CollisionGuardTests(IngestTestCase):
    def test_a_scrydex_card_claiming_the_same_product_keeps_its_price(self):
        self._sync(run="1")
        # Scrydex later lists the Luffy: both rows now claim product 552137.
        upsert_card(
            self.connection, card_id="onepiece~P-200", name="Monkey.D.Luffy", set_name="Promotion Cards",
            number="P-200", rarity="Leader", variant="Raw", language="English", game="onepiece",
            source_provider="scrydex", set_id="onepiece~P", source_payload=_payload(552137),
        )
        self.connection.commit()
        reset_collision_guard_cache()
        self.assertNotIn("552137", collision_guard(self.connection)["colliding_product_ids"])
        self._sync(run="2")
        prices = dict(self.connection.execute(
            "SELECT card_id, main_raw_market_price FROM card_price_snapshots "
            "WHERE card_id IN ('onepiece~P-200', ?)", (LUFFY_ID,)))
        self.assertEqual(prices, {"onepiece~P-200": LUFFY_PRICE, LUFFY_ID: LUFFY_PRICE})


class SearchTests(IngestTestCase):
    def test_tcgplayer_only_cards_are_searchable_without_the_pocket_penalty(self):
        self._sync()
        results = search_cards(self.connection, "Luffy", limit=10, game="onepiece")
        self.assertIn(LUFFY_ID, [card["id"] for card in results])
        tcgplayer_card = card_by_id(self.connection, LUFFY_ID)
        pocket_like = {**tcgplayer_card, "id": "tcgp-A1-001", "sourceRecordID": "tcgp-A1-001"}
        tokens = tokenize("monkey d luffy")
        self.assertGreater(
            _manual_search_score(tcgplayer_card, "monkey d luffy", tokens),
            _manual_search_score(pocket_like, "monkey d luffy", tokens),
        )


class VisualRefreshTests(IngestTestCase):
    def test_refresh_indexes_the_new_card_as_a_base_row_and_skips_null_images(self):
        self.images = {"150001": _jpeg(1000, 573)}  # placeholder -> image_url NULL
        self._sync()
        directory = Path(self.tempdir.name)
        pairs = {}
        for game, ids in (("onepiece", ["onepiece~P-001"]), ("pokemon", ["base1-4"])):
            npz = directory / f"visual_index_active_{game}.npz"
            manifest = directory / f"visual_index_active_{game}_manifest.json"
            np.savez_compressed(npz, embeddings=np.array([[0.0, 1.0, 0.0, 0.0]], dtype=np.float32))
            manifest.write_text(json.dumps({"entryCount": 1, "entries": [
                {"rowIndex": 0, "providerCardId": ids[0], "name": ids[0]}]}))
            pairs[game] = RawVisualIndex(npz_path=npz, manifest_path=manifest)

        class _Image:
            def save(self, *_args, **_kwargs):
                return None

        def embed(images):
            return np.array([[1.0, 0.0, 0.0, 0.0]] * len(images), dtype=np.float32)

        result = append_missing_cards(
            index=pairs["onepiece"], connection=self.connection, embed_images_fn=embed,
            model_id="test", download_image_fn=lambda _url: _Image(), game="onepiece",
        )
        self.assertEqual(result["added"], 1)
        entry = pairs["onepiece"].entries[-1]
        self.assertEqual(entry["providerCardId"], LUFFY_ID)
        self.assertEqual(entry["catalogSource"], "tcgplayer")
        self.assertNotIn("referenceSource", entry)
        self.assertFalse(is_alt_reference_entry(entry))
        self.assertEqual(diff_missing_ids(pairs["onepiece"], self.connection, game="onepiece"), [])

        pokemon = append_missing_cards(
            index=pairs["pokemon"], connection=self.connection, embed_images_fn=embed,
            model_id="test", download_image_fn=lambda _url: _Image(),
        )
        added = [entry["providerCardId"] for entry in pairs["pokemon"].entries[1:]]
        self.assertEqual(sorted(added), ["tcgplayer-150002", "tcgplayer-150003"])
        self.assertIn("tcgplayer-150001", pokemon["skippedIds"])


class _ServiceCase(IngestTestCase):
    def setUp(self):
        super().setUp()
        self._sync()
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)


class ServiceTests(_ServiceCase):
    def test_payloads_carry_catalog_source(self):
        detail = self.service.card_detail(LUFFY_ID)
        self.assertEqual(detail["card"]["catalogSource"], "tcgplayer")
        self.assertIsNone(detail["card"]["canonicalCardId"])
        self.assertEqual(detail["card"]["pricing"]["market"], LUFFY_PRICE)
        self.assertEqual(detail["population"], {})
        self.assertIsNone(detail["gradedReference"])
        scrydex_detail = self.service.card_detail("onepiece~P-001")
        self.assertEqual(scrydex_detail["card"]["catalogSource"], "scrydex")

        results = self.service.search("Luffy", game="onepiece")["results"]
        by_id = {card["id"]: card for card in results}
        self.assertEqual(by_id[LUFFY_ID]["catalogSource"], "tcgplayer")
        self.assertEqual(by_id["onepiece~P-001"]["catalogSource"], "scrydex")

        candidate = SpotlightScanService._candidate_base_payload(card_by_id(self.service.connection, LUFFY_ID), {})
        self.assertEqual((candidate["catalogSource"], candidate["canonicalCardId"]), ("tcgplayer", None))
        stub = self.service._visual_candidate_stub({"providerCardId": LUFFY_ID})
        self.assertEqual(stub["catalogSource"], "tcgplayer")
        self.assertEqual(catalog_source_for_card_id("tcgp-sealed-593355"), "tcgplayer")
        self.assertEqual(catalog_source_for_card_id("sv1-25"), "scrydex")

    def test_graded_holdings_are_unpriced_and_raw_holdings_price_from_tcgcsv(self):
        with self.service.request_identity_context(RequestIdentity(user_id="user-a", auth_source="test")):
            self.service.create_deck_entry({"cardID": LUFFY_ID, "quantity": 1, "condition": "near_mint"})
            self.service.create_deck_entry({"cardID": LUFFY_ID, "quantity": 1,
                                            "slabContext": {"grader": "PSA", "grade": "10"}})
            entries = self.service.deck_entries(limit=10)
            dashboard = self.service.portfolio_dashboard(range_key="1W", allow_series_compute=True)
        by_lane = {bool(entry.get("slabContext")): entry for entry in entries["entries"]}
        self.assertEqual(by_lane[False]["card"]["pricing"]["market"], LUFFY_PRICE)
        self.assertIsNone(by_lane[True]["card"].get("pricing"))
        self.assertAlmostEqual(entries["summary"]["totalValue"], LUFFY_PRICE, places=2)
        self.assertAlmostEqual(dashboard["inventory"]["summary"]["totalValue"], LUFFY_PRICE, places=2)
        self.assertAlmostEqual(
            dashboard["ranges"]["1W"]["history"]["summary"]["currentValue"], LUFFY_PRICE, places=2)


def _live_scrydex_env() -> dict[str, str]:
    return {"SCRYDEX_API_KEY": "test-key", "SCRYDEX_TEAM_ID": "test-team",
            "SPOTLIGHT_MANUAL_SCRYDEX_MIRROR": "0"}


def _explode(*_args, **_kwargs):
    raise AssertionError("a TCGplayer-only card must never reach Scrydex")


class ScrydexGuardTests(_ServiceCase):
    def test_pricing_refresh_never_asks_scrydex_on_either_lane(self):
        self.service.set_live_pricing_mode(enabled=True)
        provider = self.service.pricing_registry.get_provider("scrydex")
        provider.refresh_raw_pricing = Mock()  # type: ignore[method-assign]
        provider.refresh_psa_pricing = Mock()  # type: ignore[method-assign]
        with patch.dict(os.environ, _live_scrydex_env(), clear=False), \
                patch.object(scrydex_adapter, "scrydex_api_request", _explode):
            raw = self.service.refresh_card_pricing(LUFFY_ID, force_refresh=True)
            graded = self.service.refresh_card_pricing(LUFFY_ID, grader="PSA", grade="10", force_refresh=True)
            sealed = self.service.refresh_card_pricing("tcgp-sealed-1", grader="PSA", grade="10")
        provider.refresh_raw_pricing.assert_not_called()
        provider.refresh_psa_pricing.assert_not_called()
        self.assertEqual(raw["card"]["pricing"]["market"], LUFFY_PRICE)
        self.assertIsNotNone(graded)
        self.assertIsNone(sealed)

    def test_adapter_refuses_tcgplayer_ids_before_any_request(self):
        with patch.object(scrydex_adapter, "scrydex_api_request", _explode):
            for call in (
                lambda: scrydex_adapter.fetch_scrydex_card_by_id(LUFFY_ID, game="onepiece"),
                lambda: scrydex_adapter.fetch_scrydex_price_history("tcgplayer-150001"),
                lambda: scrydex_adapter.fetch_scrydex_recent_sales(LUFFY_ID, game="onepiece"),
                lambda: scrydex_adapter.fetch_scrydex_card_by_id("tcgp-sealed-593355"),
            ):
                with self.assertRaisesRegex(ValueError, "not a Scrydex card"):
                    call()


class DeployConfigTests(unittest.TestCase):
    def _env_value(self, name: str) -> str | None:
        for line in (BACKEND_ROOT / name).read_text().splitlines():
            if line.startswith("TCGCSV_TCGPLAYER_ONLY_INGEST="):
                return line.split("=", 1)[1].strip()
        return None

    def test_staging_and_production_both_ingest(self):
        # Production was switched on with the 2026-09-29 release (user decision).
        self.assertEqual(self._env_value(".env.staging"), "on")
        self.assertEqual(self._env_value(".env.production"), "on")

    def test_tcgcsv_cron_refreshes_the_visual_index_when_ingesting(self):
        script = (BACKEND_ROOT / "run_tcgcsv_sync_vm.sh").read_text()
        self.assertIn("TCGCSV_TCGPLAYER_ONLY_INGEST", script)
        self.assertIn("/api/v1/ops/refresh-visual-index", script)
        # The TCGCSV write invalidates every cache, so it re-warms them too.
        self.assertIn("/api/v1/ops/prewarm-portfolio", script)


if __name__ == "__main__":
    unittest.main()
