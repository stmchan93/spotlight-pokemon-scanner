"""TCGplayer-only catalog, phase P0 (shadow): unclaimed TCGCSV card products are
sorted into linked-version / missing / review / ignored and recorded in
tcgplayer_product_classifications — and nothing else in the database changes.
See docs/tcgplayer-only-catalog-plan-2026-09-29.md."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    reset_collision_guard_cache,
    upsert_card,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402
import sync_tcgcsv_prices  # noqa: E402
import tcgplayer_only_catalog as tpo  # noqa: E402

OP_PROMO_GROUP = {"groupId": 17675, "name": "One Piece Promotion Cards"}
OP_EVENT_GROUP = {"groupId": 24100, "name": "Royal Blood Release Event Cards"}
OP_SEALED_BATTLE_GROUP = {"groupId": 24999, "name": "Sealed Battle Kit Cards"}
SV1_GROUP = {"groupId": 22873, "name": "SV01: Scarlet & Violet Base Set"}
SV2_GROUP = {"groupId": 23120, "name": "SV02: Paldea Evolved"}
PRIZE_GROUP = {"groupId": 24001, "name": "Unmapped Deck Reprints"}
JP_PROMO_GROUP = {"groupId": 24143, "name": "P Promotional cards"}


def _product(product_id: int, name: str, **extended: str) -> dict:
    return {
        "productId": product_id,
        "name": name,
        "extendedData": [{"name": key, "value": value} for key, value in extended.items()],
    }


def _payload(product_id: int | str) -> dict:
    return {"variants": [{"name": "normal", "marketplaces": [
        {"name": "tcgplayer", "product_id": str(product_id)}]}]}


class TcgplayerOnlyTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "tpo.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        for name in ("load_tcgplayer_id_overrides", "load_tcgplayer_id_backfill"):
            patcher = mock.patch.object(sync_tcgcsv_prices, name, return_value={})
            patcher.start()
            self.addCleanup(patcher.stop)

        # One Piece: a promo Luffy (claimed, maps the promo group to set P), a
        # numbered Luffy Leader, and a card whose event reprint is unclaimed.
        self._card("onepiece~P-001", "Monkey.D.Luffy", "P-001", "Promo", "onepiece~P",
                   game="onepiece", product_id=450299)
        self._card("onepiece~OP01-003", "Monkey.D.Luffy", "OP01-003", "Leader", "onepiece~OP01",
                   game="onepiece", product_id=450100)
        self._card("onepiece~OP05-060", "Monkey.D.Luffy", "OP05-060", "Leader", "onepiece~OP05",
                   game="onepiece", product_id=500001)
        self._card("onepiece~OP05-001", "Sabo", "OP05-001", "Leader", "onepiece~OP05",
                   game="onepiece", product_id=500002)
        # Pokémon EN: two sets that both have a #25.
        self._card("sv1-25", "Pikachu", "025/198", "Common", "sv1", product_id=600025)
        self._card("sv1-26", "Raichu", "026/198", "Rare", "sv1", product_id=600026)
        self._card("sv2-25", "Pawmi", "025/193", "Common", "sv2", product_id=610025)
        # Pokémon JP promo set (claimed via one product so the group maps).
        self._card("miscpp_ja-1", "Pikachu", "001/P", "Promo", "miscpp_ja",
                   language="Japanese", product_id=700001)
        self._card("miscpp_ja-2", "Mew", "002/P", "Promo", "miscpp_ja", language="Japanese")
        self.connection.commit()

    def _card(self, card_id, name, number, rarity, set_id, *, game="pokemon",
              language="English", product_id=None):
        upsert_card(
            self.connection, card_id=card_id, name=name, set_name=set_id, number=number,
            rarity=rarity, variant="Raw", language=language, game=game,
            source_provider="scrydex", set_id=set_id,
            source_payload=_payload(product_id) if product_id else {},
        )

    def _crawl(self, *extra):
        return [
            (68, OP_PROMO_GROUP, _product(450299, "Monkey.D.Luffy (Promotion Pack 2022)", Number="P-001", Rarity="PR")),
            (68, OP_EVENT_GROUP, _product(500001, "Monkey.D.Luffy", Number="OP05-060", Rarity="L")),
            (3, SV1_GROUP, _product(600025, "Pikachu - 025/198", Number="025/198", Rarity="Common")),
            (3, SV2_GROUP, _product(610025, "Pawmi - 025/193", Number="025/193", Rarity="Common")),
            (85, JP_PROMO_GROUP, _product(700001, "Pikachu - 001/P", Number="001/P", Rarity="Promo")),
            *extra,
        ]

    def _classify(self, *extra, overrides=None):
        results = tpo.run_shadow_classification(
            self.connection, self._crawl(*extra), overrides=overrides or {},
        )
        self.connection.commit()
        return results

    def _row(self, product_id):
        row = self.connection.execute(
            "SELECT status, card_id, proposed_card_id, version_label, evidence_json, "
            "first_seen_at, updated_at FROM tcgplayer_product_classifications WHERE product_id = ?",
            (str(product_id),),
        ).fetchone()
        if row is None:
            return None
        return {**dict(row), "evidence": json.loads(row["evidence_json"])}


class RulesTableTests(TcgplayerOnlyTestCase):
    def test_one_piece_event_reprint_links_to_the_numbered_card(self):
        self._classify((68, OP_EVENT_GROUP, _product(
            551000, "Sabo (Royal Blood Release Event)", Number="OP05-001", Rarity="L")))
        row = self._row(551000)
        self.assertEqual(row["status"], tpo.STATUS_SHADOW_LINKED)
        self.assertEqual(row["card_id"], "onepiece~OP05-001")
        self.assertIsNone(row["proposed_card_id"])
        self.assertEqual(row["version_label"], "Royal Blood Release Event")

    def test_numberless_sealed_battle_leader_is_a_missing_card(self):
        # The trigger scan: no number, rarity L. The game has Luffy LEADERS, but
        # all numbered — a numberless product cannot be a printing of them.
        luffy = _product(552137, "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)", Rarity="L", CardType="Leader")
        for group in (OP_PROMO_GROUP, OP_SEALED_BATTLE_GROUP):
            with self.subTest(group=group["name"]):
                self._classify((68, group, luffy))
                row = self._row(552137)
                self.assertEqual(row["status"], tpo.STATUS_SHADOW_MISSING)
                self.assertEqual(row["proposed_card_id"], "onepiece~tcgplayer-552137")
                self.assertEqual(row["version_label"], "Sealed Battle 2024 Vol. 2")
                self.assertIsNone(row["card_id"])

    def test_number_match_with_a_different_name_goes_to_review(self):
        self._classify((68, OP_EVENT_GROUP, _product(551001, "Nami (Event)", Number="OP05-001", Rarity="L")))
        row = self._row(551001)
        self.assertEqual(row["status"], tpo.STATUS_REVIEW)
        self.assertEqual(row["evidence"]["reason"], "number-name-differs")
        self.assertEqual(row["evidence"]["candidates"], ["onepiece~OP05-001"])

    def test_a_new_one_piece_number_is_a_missing_card(self):
        self._classify((68, OP_PROMO_GROUP, _product(690662, "Crocodile - P-143 (Premium)", Number="P-143", Rarity="PR")))
        row = self._row(690662)
        self.assertEqual(row["status"], tpo.STATUS_SHADOW_MISSING)
        self.assertEqual(row["version_label"], "P-143; Premium")

    def test_pokemon_numbers_are_scoped_to_the_mapped_set(self):
        # "#25" is Pikachu in sv1 and Pawmi in sv2: each group resolves in its own set.
        self._classify(
            (3, SV1_GROUP, _product(600925, "Pikachu - 025/198 (Stamped)", Number="025/198", Rarity="Common")),
            (3, SV2_GROUP, _product(610925, "Pikachu - 025/193 (Stamped)", Number="025/193", Rarity="Common")),
        )
        self.assertEqual(self._row(600925)["card_id"], "sv1-25")
        self.assertEqual(self._row(600925)["status"], tpo.STATUS_SHADOW_LINKED)
        stray = self._row(610925)
        self.assertEqual(stray["status"], tpo.STATUS_REVIEW)
        self.assertEqual(stray["evidence"]["candidates"], ["sv2-25"])

    def test_pokemon_new_number_in_mapped_set_is_missing(self):
        self._classify((3, SV1_GROUP, _product(600999, "Miraidon - 250/198", Number="250/198", Rarity="Promo")))
        row = self._row(600999)
        self.assertEqual(row["status"], tpo.STATUS_SHADOW_MISSING)
        self.assertEqual(row["proposed_card_id"], "tcgplayer-600999")

    def test_pokemon_number_in_an_unmapped_group_never_matches_by_number_alone(self):
        self._classify(
            (3, PRIZE_GROUP, _product(620001, "Raichu", Number="026/198", Rarity="Rare")),
            (3, PRIZE_GROUP, _product(620002, "Brand New Mon", Number="026/198", Rarity="Rare")),
        )
        self.assertEqual(self._row(620001)["status"], tpo.STATUS_REVIEW)
        self.assertEqual(self._row(620002)["status"], tpo.STATUS_SHADOW_MISSING)

    def test_japanese_numberless_product_in_a_mapped_group_is_always_review(self):
        self._classify((85, JP_PROMO_GROUP, _product(700050, "Brand New Promo", Rarity="Promo")))
        row = self._row(700050)
        self.assertEqual(row["status"], tpo.STATUS_REVIEW)
        self.assertEqual(row["evidence"]["reason"], "jp-numberless-mapped-group")
        self.assertIsNone(row["proposed_card_id"])

    def test_alias_maps_a_japanese_group_with_no_claimed_products(self):
        # Same group, but nothing in it claimed: the hand-verified alias still
        # scopes it to miscpp_ja, so a numbered product links.
        crawl = [(85, JP_PROMO_GROUP, _product(700002, "Mew - 002/P", Number="002/P", Rarity="Promo"))]
        results = tpo.run_shadow_classification(self.connection, crawl, overrides={})
        self.assertEqual(self._row(700002)["card_id"], "miscpp_ja-2")
        self.assertEqual(self._row(700002)["evidence"]["mapping"], "alias")
        self.assertEqual(results["counts"]["pokemon-jp"], {tpo.STATUS_SHADOW_LINKED: 1})

    def test_overrides_win(self):
        crawl = (
            (68, OP_EVENT_GROUP, _product(551002, "Nami (Event)", Number="OP05-001", Rarity="L")),
            (68, OP_PROMO_GROUP, _product(552137, "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)", Rarity="L")),
            (3, SV1_GROUP, _product(600925, "Pikachu - 025/198 (Stamped)", Number="025/198", Rarity="Common")),
        )
        self._classify(*crawl, overrides={
            "551002": {"action": "link", "cardId": "onepiece~OP05-001", "label": "Hand-checked"},
            "552137": {"action": "ignore"},
            "600925": {"action": "create"},
        })
        self.assertEqual(self._row(551002)["status"], tpo.STATUS_SHADOW_LINKED)
        self.assertEqual(self._row(551002)["version_label"], "Hand-checked")
        self.assertEqual(self._row(552137)["status"], tpo.STATUS_IGNORED)
        self.assertEqual(self._row(600925)["status"], tpo.STATUS_SHADOW_MISSING)
        self.assertEqual(self._row(600925)["proposed_card_id"], "tcgplayer-600925")

    def test_sealed_and_code_cards_are_never_card_rows(self):
        self._classify(
            (3, SV1_GROUP, _product(593355, "Scarlet & Violet Elite Trainer Box", CardText="x")),
            (3, SV1_GROUP, _product(616163, "Code Card - Scarlet & Violet Booster", Rarity="Code Card")),
        )
        self.assertIsNone(self._row(593355))  # sealed: the sealed ingest owns it
        self.assertEqual(self._row(616163)["status"], tpo.STATUS_IGNORED)

    def test_jumbo_and_don_are_included_with_a_class_label(self):
        # Plan D2: nothing but sealed/non-card/code cards is excluded.
        self._classify(
            (68, OP_PROMO_GROUP, _product(655110, "DON!! Card (Marco)", Rarity="DON!!", CardType="DON!!")),
            (68, OP_PROMO_GROUP, _product(649678, "Monkey.D.Luffy (OP05-060) (Jumbo)", Number="OP05-060", Rarity="L")),
        )
        don = self._row(655110)
        self.assertEqual((don["status"], don["evidence"]["class"]), (tpo.STATUS_SHADOW_MISSING, "don"))
        jumbo = self._row(649678)
        self.assertEqual((jumbo["status"], jumbo["evidence"]["class"]), (tpo.STATUS_SHADOW_LINKED, "oversized"))

    def test_claimed_products_are_skipped(self):
        results = self._classify()
        self.assertEqual(results["claimed"], 5)
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM tcgplayer_product_classifications").fetchone()[0], 0
        )

    def test_rerun_is_idempotent_and_drops_rows_the_catalog_later_claims(self):
        extra = (
            (68, OP_EVENT_GROUP, _product(551000, "Sabo (Event)", Number="OP05-001", Rarity="L")),
            (68, OP_PROMO_GROUP, _product(552137, "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)", Rarity="L")),
        )
        first = self._classify(*extra)
        before = {pid: self._row(pid) for pid in (551000, 552137)}
        second = self._classify(*extra)
        self.assertEqual(first["counts"], second["counts"])
        for pid in (551000, 552137):
            after = self._row(pid)
            self.assertEqual(after["first_seen_at"], before[pid]["first_seen_at"])
            self.assertEqual(after["status"], before[pid]["status"])
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM tcgplayer_product_classifications").fetchone()[0], 2
        )
        # Scrydex adds the card: its product is claimed, the shadow row goes.
        self._card("onepiece~P-200", "Monkey.D.Luffy", "P-200", "Leader", "onepiece~P",
                   game="onepiece", product_id=552137)
        self._classify(*extra)
        self.assertIsNone(self._row(552137))

    def test_real_statuses_are_never_rewritten(self):
        self.connection.execute(
            "INSERT INTO tcgplayer_product_classifications (product_id, category_id, group_id, game, "
            "status, card_id, proposed_card_id, evidence_json, first_seen_at, updated_at) "
            "VALUES ('551000', 68, 24100, 'onepiece', 'created', NULL, 'onepiece~tcgplayer-551000', '{}', 't0', 't0')"
        )
        self._classify((68, OP_EVENT_GROUP, _product(551000, "Sabo (Event)", Number="OP05-001", Rarity="L")))
        row = self._row(551000)
        self.assertEqual((row["status"], row["updated_at"]), ("created", "t0"))

    def test_on_mode_is_not_built(self):
        with self.assertRaises(NotImplementedError):
            tpo.run_shadow_classification(self.connection, self._crawl(), mode=tpo.MODE_ON)


class HelperTests(unittest.TestCase):
    def test_name_split_and_normalization(self):
        self.assertEqual(
            tpo.split_product_name("Monkey.D.Luffy - ST01-001 [Serial Number]"),
            ("Monkey.D.Luffy", "ST01-001; Serial Number"),
        )
        self.assertEqual(tpo.split_product_name("Pikachu - 001/SV-P"), ("Pikachu", "001/SV-P"))
        self.assertEqual(tpo.split_product_name("Mickey Mouse - Detective"), ("Mickey Mouse - Detective", ""))
        self.assertEqual(tpo.normalize_name("Flabébé"), tpo.normalize_name("flabebe"))
        self.assertEqual(tpo.normalize_name("Basic Grass Energy"), tpo.normalize_name("Grass Energy"))
        self.assertIn(tpo.normalize_name("Mickey Mouse"), tpo.product_name_keys("Mickey Mouse - True Friend"))

    def test_rarity_classes_fold_tcgplayer_codes(self):
        self.assertEqual(tpo.rarity_class("L"), tpo.rarity_class("Leader"))
        self.assertEqual(tpo.rarity_class("PR"), tpo.rarity_class("Promo"))
        self.assertEqual(tpo.rarity_class("None"), "")

    def test_riftbound_numbers_keep_their_denominator(self):
        self.assertNotEqual(tpo.number_key("riftbound", "001/298"), tpo.number_key("riftbound", "001/221"))
        self.assertEqual(tpo.number_key("onepiece", "OP01-001"), tpo.number_key("onepiece", "op01-001"))

    def test_proposed_ids_never_use_the_pocket_prefix(self):
        self.assertEqual(tpo.proposed_card_id("pokemon", 552137), "tcgplayer-552137")
        self.assertEqual(tpo.proposed_card_id("gundam", "1"), "gundam~tcgplayer-1")

    def test_ingest_mode_defaults_to_shadow(self):
        for value, expected in ((None, "shadow"), ("off", "off"), ("shadow", "shadow"), ("on", "on")):
            env = {} if value is None else {"TCGCSV_TCGPLAYER_ONLY_INGEST": value}
            with self.subTest(value=value), mock.patch.dict(os.environ, env, clear=False):
                if value is None:
                    os.environ.pop("TCGCSV_TCGPLAYER_ONLY_INGEST", None)
                self.assertEqual(tpo.ingest_mode(), expected)

    def test_shipped_overrides_file_is_empty(self):
        self.assertEqual(tpo.load_overrides(), {})


class SyncHookTests(TcgplayerOnlyTestCase):
    """Shadow mode inside the real nightly sync: classifications land, and the
    catalog, product links and prices are exactly what they were without it."""

    PRICES = {
        "600025": {"Normal": {"productId": 600025, "subTypeName": "Normal", "marketPrice": 1.5}},
        "552137": {"Normal": {"productId": 552137, "subTypeName": "Normal", "marketPrice": 5.16}},
    }

    def _snapshot(self):
        tables = {}
        for table in ("cards", "card_tcgplayer_products", "card_price_snapshots",
                      "card_price_history_daily", "card_price_history_cell"):
            columns = [row[1] for row in self.connection.execute(f"PRAGMA table_info({table})")]
            # Timestamps move on every run; everything else must not.
            keep = [column for column in columns if not column.endswith("_at")]
            tables[table] = sorted(
                tuple(row) for row in self.connection.execute(f"SELECT {', '.join(keep)} FROM {table}")
            )
        return tables

    def _sync(self, mode):
        crawl = self._crawl((68, OP_PROMO_GROUP, _product(
            552137, "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)", Rarity="L")))

        def fake_build(categories, group_by_product=None, failed_groups=None, product_rows_out=None):
            product_rows_out.extend(crawl)
            return self.PRICES, {}

        env = {"TCGCSV_TCGPLAYER_ONLY_INGEST": mode, "TCGCSV_SEALED_INGEST": "off"}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(sync_tcgcsv_prices, "build_price_and_number_maps", side_effect=fake_build):
            return sync_tcgcsv_prices.run_tcgcsv_price_sync(
                self.connection, product_price_map=None, price_date="2026-09-29",
                last_updated=f"2026-09-29T20:00:00Z-{mode}", force=True,
            )

    def _notes(self):
        row = self.connection.execute(
            "SELECT notes_json FROM provider_sync_runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        return json.loads(row[0])

    def test_shadow_writes_classifications_but_no_cards_links_or_prices(self):
        self._sync("off")
        baseline = self._snapshot()
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM tcgplayer_product_classifications").fetchone()[0], 0
        )
        self.assertNotIn("tcgplayerOnlyShadowMissing", self._notes())

        stats = self._sync("shadow")
        self.assertEqual(stats["priced"], 1)
        self.assertEqual(self._snapshot(), baseline)
        self.assertEqual(self._row(552137)["status"], tpo.STATUS_SHADOW_MISSING)
        self.assertEqual(self._row(552137)["evidence"]["marketPrice"], 5.16)
        self.assertIsNone(self.connection.execute(
            "SELECT 1 FROM cards WHERE id LIKE '%tcgplayer-%'").fetchone())
        notes = self._notes()
        self.assertEqual(notes["tcgplayerOnlyShadowMissing"]["onepiece"], 1)
        self.assertIn("tcgplayerOnlyShadowLinked", notes)
        self.assertIn("tcgplayerOnlyReview", notes)
        self.assertIn("tcgplayerOnlyIgnored", notes)

    def test_on_runs_as_shadow_in_this_phase(self):
        self._sync("off")
        baseline = self._snapshot()
        self._sync("on")
        self.assertEqual(self._snapshot(), baseline)
        self.assertEqual(self._row(552137)["status"], tpo.STATUS_SHADOW_MISSING)


if __name__ == "__main__":
    unittest.main()
