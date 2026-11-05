from __future__ import annotations

import io
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(BACKEND_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tools"))

import art_groups  # noqa: E402
import art_search  # noqa: E402
import tag_card_art  # noqa: E402
from art_groups import CardRow, build_art_groups  # noqa: E402
from art_search import ArtFilterError, get_card_art, list_facets, search_card_ids  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402


def _png_bytes(color=(40, 80, 200), size=(1100, 1536)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


class _DbCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "art.sqlite"
        self.conn = connect(self.db_path)
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.conn.close()
        self.tempdir.cleanup()

    def card(self, card_id: str, name: str, *, dex: list[int] | None = None, language: str = "English",
             artist: str = "Mitsuhiro Arita", rarity: str = "Common", release: str = "2020-01-01",
             set_name: str = "Base Set") -> None:
        upsert_card(
            self.conn,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number="1",
            rarity=rarity,
            variant="Raw",
            language=language,
            supertype="Pokémon",
            artist=artist,
            national_pokedex_numbers=dex or [],
            set_release_date=release,
            image_url=f"https://img.example/{card_id}.png",
            source_payload={"id": card_id},
        )
        self.conn.commit()

    def price(self, card_id: str, *, main: float | None = None, default: float | None = None, currency: str = "USD") -> None:
        self.conn.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, "
            "default_raw_market_price, main_raw_market_price, updated_at) VALUES (?, 'scrydex', ?, ?, ?, ?)",
            (card_id, currency, default, main, utc_now()),
        )
        self.conn.commit()

    def tag(self, group_id: str, members: dict[str, str], rows: list[tuple], alt_text: str = "") -> None:
        tag_card_art.write_tagged_groups(
            self.conn,
            [{
                "art_group_id": group_id,
                "representative_card_id": group_id,
                "members": members,
                "tags": {"rows": len(rows)},
                "rows": rows,
                "alt_text": alt_text or None,
            }],
            model="claude-sonnet-5-5",
        )


class VocabSchemaTests(unittest.TestCase):
    def _walk(self, node, path="$"):
        yield path, node
        if isinstance(node, dict):
            for key, value in node.items():
                yield from self._walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                yield from self._walk(value, f"{path}[{i}]")

    def test_schema_enums_match_vocab_and_are_strict(self) -> None:
        schema = tag_card_art.output_schema()
        props = schema["properties"]
        for facet in tag_card_art.MODEL_LIST_FACETS:
            self.assertEqual(props[facet]["items"]["properties"]["value"]["enum"], list(art_search.ART_FACETS[facet]))
        for facet in tag_card_art.MODEL_SINGLE_FACETS:
            self.assertEqual(props[facet]["enum"], list(art_search.ART_FACETS[facet]))
        self.assertNotIn("palette", props)  # computed locally, never asked
        for banned in ("artist", "set", "rarity", "language", "types"):
            self.assertNotIn(banned, props)
        for path, node in self._walk(schema):
            if isinstance(node, dict) and node.get("type") == "object":
                self.assertIs(node.get("additionalProperties"), False, path)
                self.assertEqual(sorted(node["required"]), sorted(node["properties"]), path)
            if isinstance(node, dict):
                for unsupported in ("minimum", "maximum", "maxItems", "minLength", "maxLength"):
                    self.assertNotIn(unsupported, node, path)

    def test_vocab_v1_shapes(self) -> None:
        self.assertEqual(art_search.VOCAB_VERSION, "v1.1")
        self.assertEqual(len(art_search.ART_FACETS["scene"]), 28)
        self.assertEqual(len(art_search.ART_FACETS["palette"]), 16)
        self.assertIn("none_visible", art_search.ART_FACETS["weather_time"])


class ArtGroupingTests(unittest.TestCase):
    def row(self, card_id, name="Pikachu", language="English", artist="Atsuko Nishida", release="2020-01-01"):
        return CardRow(card_id, name, language, artist, "Pokémon", release, f"https://x/{card_id}.png")

    def test_language_link_and_reprint_and_self(self) -> None:
        cards = [
            self.row("jp-1", language="Japanese", release="2019-01-01"),
            self.row("en-1"),
            self.row("en-1-reprint", name="Pikachu (Reprint)", release="2021-01-01"),
            self.row("en-other-artist", artist="Ken Sugimori"),
            self.row("en-low-score"),
            self.row("en-diff-name", name="Raichu"),
            self.row("en-alone", name="Eevee"),
        ]
        links = [("en-1", "jp-1"), ("jp-1", "en-1")]
        threshold = art_groups.REPRINT_MIN_SCORE
        similar = [
            ("en-1", "en-1-reprint", threshold + 0.01),
            ("en-1", "en-other-artist", 0.99),
            ("en-1", "en-low-score", threshold - 0.01),
            ("en-1", "en-diff-name", 0.99),
            ("en-1", "missing-card", 0.99),
        ]
        groups = {g.art_group_id: g for g in build_art_groups(cards, links, similar)}
        main = groups["en-1"]  # EN wins canonical even though JP released first
        self.assertEqual(main.members, {"en-1": "self", "jp-1": "language_link", "en-1-reprint": "reprint_similar"})
        for alone in ("en-other-artist", "en-low-score", "en-diff-name", "en-alone"):
            self.assertEqual(groups[alone].members, {alone: "self"})
        self.assertEqual(len(groups), 5)

    def test_empty_artist_never_merges(self) -> None:
        cards = [self.row("a", artist=""), self.row("b", artist="")]
        groups = build_art_groups(cards, [], [("a", "b", 0.999)])
        self.assertEqual(len(groups), 2)


class ResultParsingTests(_DbCase):
    def setUp(self) -> None:
        super().setUp()
        self.card("pika", "Pikachu", dex=[25])
        self.card("mime", "Mr. Mime", dex=[122])
        self.index = art_search.build_pokemon_name_index(self.conn)

    @staticmethod
    def _line(custom_id, payload=None, *, kind="succeeded", stop="end_turn", text=None):
        if kind != "succeeded":
            return {"custom_id": custom_id, "result": {"type": kind, "error": {"type": "error", "error": {"type": "overloaded_error", "message": "x"}}}}
        return {
            "custom_id": custom_id,
            "result": {"type": "succeeded", "message": {
                "stop_reason": stop,
                "content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": text if text is not None else json.dumps(payload)}],
            }},
        }

    def test_parse_result_kinds(self) -> None:
        cid, parsed, err = tag_card_art.parse_result_line(self._line("a", {"x": 1}))
        self.assertEqual((cid, parsed, err), ("a", {"x": 1}, None))
        for line in (self._line("b", kind="errored"), self._line("c", kind="expired"),
                     self._line("d", {"x": 1}, stop="refusal"), self._line("e", {"x": 1}, stop="max_tokens"),
                     self._line("f", text="not json")):
            _, parsed, err = tag_card_art.parse_result_line(line)
            self.assertIsNone(parsed)
            self.assertTrue(err)

    def test_normalize_drops_unresolvable_pokemon_and_bad_values(self) -> None:
        raw = {
            "scene": [{"value": "beach", "confidence": 0.9}, {"value": "moon_base", "confidence": 0.9}],
            "weather_time": [{"value": "rain", "confidence": 0.4}],
            "activity": [{"value": "sleeping", "confidence": 1.7}],
            "mood": [],
            "objects": [{"value": v, "confidence": 0.8} for v in art_search.ART_FACETS["objects"][:10]],
            "art_style": "watercolor",
            "composition": "not_a_composition",
            "appearing_pokemon": [
                {"name": "Pikachu", "role": "main", "confidence": 0.95},
                {"name": "mr. mime", "role": "cameo", "confidence": 0.7},
                {"name": "Fakemon Supreme", "role": "background", "confidence": 0.99},
            ],
            "characters": ["Ash", "ash", "Misty"],
            "alt_text": "  Pikachu   naps on a beach. ",
        }
        tags, rows, alt = tag_card_art.normalize_tags(raw, name_index=self.index, palette=[{"color": "blue", "share": 0.9}, {"color": "chartreuse", "share": 0.1}])
        self.assertEqual([p["dex"] for p in tags["appearing_pokemon"]], [25, 122])
        self.assertNotIn("Fakemon", json.dumps(tags))
        self.assertEqual([s["value"] for s in tags["scene"]], ["beach"])
        self.assertTrue(tags["weather_time"][0]["low_confidence"])
        self.assertEqual(tags["activity"][0]["confidence"], 1.0)
        self.assertEqual(len(tags["objects"]), tag_card_art.MAX_OBJECTS)
        self.assertIsNone(tags["composition"])
        self.assertEqual(tags["characters"], ["Ash", "Misty"])
        self.assertEqual([p["color"] for p in tags["palette"]], ["blue"])
        self.assertEqual(alt, "Pikachu naps on a beach.")
        flat = {(f, v): (r, c) for f, v, r, c in rows}
        self.assertEqual(flat[("pokemon", "25")], ("main", 0.95))
        self.assertEqual(flat[("pokemon", "122")][0], "cameo")
        self.assertIn(("weather_time", "rain"), flat)  # stored even though low confidence
        self.assertIn(("palette", "blue"), flat)

    def test_collect_keyed_by_custom_id_and_written_in_one_go(self) -> None:
        manifest = {
            "pika": {"art_group_id": "pika", "representative_card_id": "pika", "members": {"pika": "self"}, "palette": []},
            "mime": {"art_group_id": "mime", "representative_card_id": "mime", "members": {"mime": "self"}, "palette": []},
        }
        lines = [
            self._line("mime", {"scene": [{"value": "city_street", "confidence": 0.8}], "appearing_pokemon": [], "alt_text": "Mime"}),
            self._line("ghost", {"scene": []}),
            self._line("pika", {"scene": [{"value": "beach", "confidence": 0.8}], "appearing_pokemon": [], "alt_text": "Pika"}),
            self._line("pika2", kind="expired"),
        ]
        random.Random(3).shuffle(lines)
        entries, errors = tag_card_art.collect_entries(self.conn, lines, manifest)
        self.assertEqual(set(errors), {"ghost", "pika2"})
        tag_card_art.write_tagged_groups(self.conn, entries, model="claude-sonnet-5-5")
        art = get_card_art(self.conn, "pika")
        self.assertEqual(art["alt_text"], "Pika")
        self.assertEqual(art["tags"]["scene"][0]["value"], "beach")
        mime_scene = self.conn.execute("SELECT value FROM card_art_tags WHERE art_group_id = 'mime' AND facet = 'scene'").fetchall()
        self.assertEqual([r[0] for r in mime_scene], ["city_street"])
        self.assertIsNone(get_card_art(self.conn, "nope"))

    def test_select_skips_current_and_human_reviewed(self) -> None:
        groups = art_groups.compute_art_groups(self.conn)
        self.assertEqual({c.group.art_group_id for c in tag_card_art.select_groups(self.conn, groups)}, {"pika", "mime"})
        self.tag("pika", {"pika": "self"}, [])
        self.assertEqual([c.group.art_group_id for c in tag_card_art.select_groups(self.conn, groups)], ["mime"])
        self.assertEqual(len(tag_card_art.select_groups(self.conn, groups, prompt_version="p2")), 2)
        self.conn.execute("UPDATE card_art_groups SET review_state = 'human_fixed'")
        self.conn.commit()
        self.assertEqual(len(tag_card_art.select_groups(self.conn, groups, prompt_version="p2")), 1)
        self.assertEqual(len(tag_card_art.select_groups(self.conn, groups, card_ids={"mime"})), 1)
        self.assertEqual(len(tag_card_art.select_groups(self.conn, groups, limit=1, prompt_version="p9")), 1)


class BatchBuildingTests(_DbCase):
    def setUp(self) -> None:
        super().setUp()
        self.card("sv1-25", "Pikachu", dex=[25])
        self.card("weird id/with:chars", "Eevee", dex=[133])

    def test_dry_run_writes_jsonl_without_network(self) -> None:
        out = Path(self.tempdir.name) / "out"
        with mock.patch.object(tag_card_art, "fetch_image", side_effect=lambda url, **_: _png_bytes()), \
                mock.patch.object(tag_card_art, "urlopen", side_effect=AssertionError("network")), \
                mock.patch.object(tag_card_art, "submit_batch", side_effect=AssertionError("network")):
            code = tag_card_art.main(["--database", str(self.db_path), "--dry-run", "--out", str(out)])
        self.assertEqual(code, 0)
        jsonl = next(out.glob("dry-run-*.requests.jsonl"))
        requests = [json.loads(line) for line in jsonl.read_text().splitlines()]
        manifest = json.loads(next(out.glob("dry-run-*.manifest.json")).read_text())
        self.assertEqual(len(requests), 2)
        by_group = {manifest["groups"][r["custom_id"]]["art_group_id"]: r for r in requests}
        self.assertEqual(by_group["sv1-25"]["custom_id"], "sv1-25")
        weird = by_group["weird id/with:chars"]["custom_id"]
        self.assertRegex(weird, r"^[A-Za-z0-9_-]{1,64}$")
        params = by_group["sv1-25"]["params"]
        self.assertEqual(params["model"], "claude-sonnet-5-5")
        for banned in ("temperature", "top_p", "top_k", "tool_choice", "tools"):
            self.assertNotIn(banned, params)
        self.assertEqual(params["messages"][-1]["role"], "user")
        self.assertEqual(len(params["messages"]), 1)
        self.assertEqual(params["output_config"]["effort"], "low")
        self.assertEqual(params["output_config"]["format"]["type"], "json_schema")
        image = params["messages"][0]["content"][0]
        self.assertEqual(image["source"]["media_type"], "image/jpeg")
        meta = manifest["groups"]["sv1-25"]
        self.assertEqual(max(meta["image_size"]), tag_card_art.MAX_EDGE)
        self.assertEqual(meta["palette"][0]["color"], "blue")

    def test_image_failure_is_skipped(self) -> None:
        groups = art_groups.compute_art_groups(self.conn)
        candidates = tag_card_art.select_groups(self.conn, groups)

        def fetcher(url):
            if "sv1-25" in url:
                raise OSError("404")
            return _png_bytes((240, 150, 190), size=(300, 420))

        requests, manifest, failed = tag_card_art.prepare_batch(candidates, model="claude-haiku-5-5", fetcher=fetcher, workers=1)
        self.assertEqual(failed, ["sv1-25"])
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["params"]["model"], "claude-haiku-5-5")
        only = next(iter(manifest.values()))
        self.assertEqual(only["image_size"], [300, 420])  # never upscaled
        self.assertEqual(only["palette"][0]["color"], "pink")

    def test_estimate_math(self) -> None:
        est = tag_card_art.estimate_cost(1000, model="claude-haiku-5-5", image_sizes=[(750, 1000)] * 1000)
        text_per = len(tag_card_art.SYSTEM_PROMPT) / 4 + len(json.dumps(tag_card_art.output_schema())) / 4 + 20
        expected_in = 1000 * (1000 + text_per)
        self.assertEqual(est["input_tokens"], int(expected_in))
        expected = expected_in / 1e6 * 0.10 + 1000 * tag_card_art.EST_OUTPUT_TOKENS / 1e6 * 0.50
        self.assertAlmostEqual(est["list_usd"], round(expected, 4), places=4)
        self.assertAlmostEqual(est["batch_usd"], round(expected * 0.5, 4), places=4)
        self.assertEqual(tag_card_art.MODEL_PRICES["claude-opus-5-5"], (4.0, 20.0))

    def test_submit_and_collect_use_mocked_http(self) -> None:
        calls = []

        def fake_api(method, url, payload=None, **_):
            calls.append((method, url))
            if method == "POST":
                self.assertEqual(len(payload["requests"]), 1)
                return json.dumps({"id": "msgbatch_1", "processing_status": "in_progress"}).encode()
            if url.endswith("/msgbatch_1"):
                return json.dumps({"id": "msgbatch_1", "processing_status": "ended", "results_url": "https://r/x"}).encode()
            line = {"custom_id": "sv1-25", "result": {"type": "succeeded", "message": {"stop_reason": "end_turn", "content": [
                {"type": "text", "text": json.dumps({"activity": [{"value": "sleeping", "confidence": 0.9}], "appearing_pokemon": [{"name": "Pikachu", "role": "main", "confidence": 0.9}], "alt_text": "zz"})}]}}}
            return (json.dumps(line) + "\n").encode()

        out = Path(self.tempdir.name) / "out"
        ids_file = Path(self.tempdir.name) / "ids.txt"
        ids_file.write_text("sv1-25\n")
        with mock.patch.object(tag_card_art, "_api", side_effect=fake_api), \
                mock.patch.object(tag_card_art, "fetch_image", side_effect=lambda url, **_: _png_bytes()):
            self.assertEqual(tag_card_art.main(["--database", str(self.db_path), "--submit", "--card-ids-file", str(ids_file), "--out", str(out)]), 0)
            self.assertTrue((out / "msgbatch_1.manifest.json").exists())
            self.assertEqual(tag_card_art.main(["--database", str(self.db_path), "--collect", "msgbatch_1", "--out", str(out)]), 0)
        self.assertEqual([c[0] for c in calls], ["POST", "GET", "GET"])
        self.conn.close()
        self.conn = connect(self.db_path)
        art = get_card_art(self.conn, "sv1-25")
        self.assertEqual(art["tags"]["activity"][0]["value"], "sleeping")
        group = self.conn.execute("SELECT tagger_model, prompt_version, vocab_version FROM card_art_groups").fetchone()
        self.assertEqual(tuple(group), ("claude-sonnet-5-5", tag_card_art.PROMPT_VERSION, "v1.1"))


class ArtSearchTests(_DbCase):
    def setUp(self) -> None:
        super().setUp()
        self.card("pika-beach", "Pikachu", dex=[25], rarity="Special Illustration Rare", release="2023-01-01")
        self.card("pika-beach-jp", "Pikachu", dex=[25], language="Japanese", release="2022-12-01")
        self.card("snorlax-bed", "Snorlax", dex=[143], release="2021-01-01", artist="Kouki Saitou")
        self.card("eevee-rain", "Eevee", dex=[133], release="2019-01-01")
        self.card("pika-untagged", "Pikachu", dex=[25])
        self.price("pika-beach", main=12.5)
        self.price("pika-beach-jp", default=3000.0, currency="JPY")  # JPY-only -> unpriced
        self.price("snorlax-bed", default=4.0, currency="USD")
        self.tag("pika-beach", {"pika-beach": "self", "pika-beach-jp": "language_link"}, [
            ("scene", "beach", None, 0.9),
            ("weather_time", "rain", None, 0.4),  # low confidence: must not match
            ("activity", "sleeping", None, 0.8),
            ("pokemon", "25", "main", 0.95),
            ("pokemon", "133", "background", 0.7),
            ("palette", "yellow", None, 1.0),
        ], alt_text="Pikachu dozes on a sunny beach.")
        self.tag("snorlax-bed", {"snorlax-bed": "self"}, [
            ("scene", "bedroom", None, 0.9),
            ("activity", "sleeping", None, 0.95),
            ("mood", "cozy", None, 0.9),
            ("pokemon", "143", "main", 0.9),
        ])
        self.tag("eevee-rain", {"eevee-rain": "self"}, [
            ("weather_time", "rain", None, 0.9),
            ("pokemon", "133", "main", 0.9),
        ])

    def ids(self, card_filter, **kwargs):
        return search_card_ids(self.conn, card_filter, **kwargs)["card_ids"]

    def test_facet_filters_and_low_confidence(self) -> None:
        self.assertEqual(sorted(self.ids({"scene": ["beach"]})), ["pika-beach", "pika-beach-jp"])
        self.assertEqual(self.ids({"weather_time": ["rain"]}), ["eevee-rain"])
        self.assertEqual(sorted(self.ids({"activity": ["sleeping"], "language": "English"})), ["pika-beach", "snorlax-bed"])
        self.assertEqual(self.ids({"activity": ["sleeping"], "mood": ["cozy"]}), ["snorlax-bed"])
        self.assertEqual(self.ids({"palette": ["yellow"], "language": "Japanese"}), ["pika-beach-jp"])
        self.assertEqual(self.ids({"theme": "sleepy", "artist": "saitou"}), ["snorlax-bed"])
        self.assertEqual(self.ids({"rarity_bucket": ["sir"]}), ["pika-beach"])

    def test_unknown_values_raise_with_valid_list(self) -> None:
        with self.assertRaises(ArtFilterError) as ctx:
            search_card_ids(self.conn, {"scene": ["moon"]})
        self.assertIn("beach", str(ctx.exception))
        for bad in ({"theme": "nope"}, {"language": "French"}, {"rarity_bucket": ["mega"]}, {"bogus": 1}):
            with self.assertRaises(ArtFilterError):
                search_card_ids(self.conn, bad)
        with self.assertRaises(ArtFilterError):
            search_card_ids(self.conn, {}, sort="random")

    def test_pokemon_roles(self) -> None:
        self.assertEqual(sorted(self.ids({"pokemon": ["Eevee"]})), ["eevee-rain", "pika-beach", "pika-beach-jp"])
        self.assertEqual(sorted(self.ids({"pokemon": [133], "pokemon_role": "background_or_cameo"})), ["pika-beach", "pika-beach-jp"])
        self.assertEqual(self.ids({"pokemon": ["eevee"], "pokemon_role": "main"}), ["eevee-rain"])
        self.assertEqual(self.ids({"pokemon": ["Missingno Prime"]}), [])
        # Untagged printings never appear in art search.
        self.assertNotIn("pika-untagged", self.ids({"pokemon": ["Pikachu"]}))

    def test_free_text(self) -> None:
        self.assertEqual(sorted(self.ids({"text": "Pikachu sleeping"})), ["pika-beach", "pika-beach-jp"])
        self.assertEqual(self.ids({"text": "rainy"}), ["eevee-rain"])
        self.assertEqual(sorted(self.ids({"text": "sunny beach"})), ["pika-beach", "pika-beach-jp"])
        ranked = self.ids({"text": "sleeping"}, sort="relevance")
        self.assertEqual(ranked[0], "snorlax-bed")  # 0.95 beats 0.8

    def test_owned_modes(self) -> None:
        owned = {"snorlax-bed"}
        self.assertEqual(self.ids({"activity": ["sleeping"]}, owned_card_ids=owned, owned_mode="owned"), ["snorlax-bed"])
        self.assertNotIn("snorlax-bed", self.ids({"activity": ["sleeping"]}, owned_card_ids=owned, owned_mode="not_owned"))
        self.assertEqual(self.ids({}, owned_card_ids=None, owned_mode="owned"), [])
        with self.assertRaises(ArtFilterError):
            search_card_ids(self.conn, {}, owned_mode="mine")

    def test_usd_only_price_rule(self) -> None:
        self.assertEqual(self.ids({}, sort="price_desc"), ["pika-beach", "snorlax-bed", "eevee-rain", "pika-beach-jp"])
        self.assertEqual(self.ids({}, sort="price_asc")[:2], ["snorlax-bed", "pika-beach"])
        self.assertEqual(sorted(self.ids({"price_min_usd": 1})), ["pika-beach", "snorlax-bed"])
        self.assertEqual(self.ids({"price_min_usd": 100}), [])  # JPY 3000 never counts as $3000
        self.assertEqual(self.ids({"price_max_usd": 5}), ["snorlax-bed"])
        self.assertEqual(self.ids({}, sort="newest")[0], "pika-beach")

    def test_cursor_pagination(self) -> None:
        first = search_card_ids(self.conn, {}, sort="newest", limit=3)
        self.assertEqual(first["total_estimate"], 4)
        self.assertEqual(len(first["card_ids"]), 3)
        second = search_card_ids(self.conn, {}, sort="newest", limit=3, cursor=first["next_cursor"])
        self.assertEqual(len(second["card_ids"]), 1)
        self.assertIsNone(second["next_cursor"])
        self.assertFalse(set(first["card_ids"]) & set(second["card_ids"]))
        with self.assertRaises(ArtFilterError):
            search_card_ids(self.conn, {"scene": ["beach"]}, sort="newest", cursor=first["next_cursor"])
        with self.assertRaises(ArtFilterError):
            search_card_ids(self.conn, {}, cursor="garbage!!")
        self.assertEqual(len(search_card_ids(self.conn, {}, limit=500)["card_ids"]), 4)

    def test_list_facets(self) -> None:
        payload = list_facets(self.conn)
        activity = {item["value"]: item["count"] for item in payload["facets"]["activity"]}
        self.assertEqual(activity, {"sleeping": 2})
        weather = {item["value"]: item["count"] for item in payload["facets"]["weather_time"]}
        self.assertEqual(weather, {"rain": 1})  # the 0.4 tag is ignored
        themes = {t["id"]: t for t in payload["themes"]}
        self.assertEqual(themes["sleepy"]["count"], 2)
        self.assertEqual(themes["sleepy"]["label"], "Sleepy")
        self.assertEqual(themes["beach_day"]["count"], 1)
        self.assertEqual(list_facets(self.conn, game="onepiece")["themes"], [])

    def test_get_card_art_from_any_member(self) -> None:
        self.assertEqual(get_card_art(self.conn, "pika-beach-jp")["art_group_id"], "pika-beach")
        self.assertEqual(get_card_art(self.conn, "pika-beach-jp")["alt_text"], "Pikachu dozes on a sunny beach.")


class ArtSearchServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        from server import SpotlightScanService

        self.tempdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tempdir.name) / "svc.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = SpotlightScanService(db_path, REPO_ROOT)
        conn = self.service.connection
        for card_id in ("a", "b"):
            upsert_card(conn, card_id=card_id, name="Pikachu", set_name="S", number="1", rarity="Common",
                        variant="Raw", language="English", national_pokedex_numbers=[25],
                        image_url=f"https://x/{card_id}.png", source_payload={"id": card_id})
            tag_card_art.write_tagged_groups(conn, [{
                "art_group_id": card_id, "representative_card_id": card_id, "members": {card_id: "self"},
                "tags": {}, "rows": [("scene", "beach", None, 0.9)], "alt_text": None,
            }], model="claude-sonnet-5-5")
        now = utc_now()
        conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, quantity, added_at, updated_at) "
            "VALUES ('d1', 'user-a', 'a', 'raw', 'a', 1, ?, ?)",
            (now, now),
        )
        conn.commit()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_owned_mode_uses_caller_holdings(self) -> None:
        from request_auth import RequestIdentity

        with self.service.request_identity_context(RequestIdentity(user_id="user-a", auth_source="test")):
            owned = self.service.art_search_cards({"scene": ["beach"]}, owned_mode="owned")
            not_owned = self.service.art_search_cards({"scene": ["beach"]}, owned_mode="not_owned")
        self.assertEqual(owned["cardIds"], ["a"])
        self.assertEqual(owned["cards"][0]["name"], "Pikachu")
        self.assertEqual(not_owned["cardIds"], ["b"])
        facets = self.service.art_facets(game="pokemon")
        self.assertEqual(facets["facets"]["scene"], [{"value": "beach", "count": 2}])

    def test_query_param_mapping(self) -> None:
        from server import _art_filter_from_query

        mapped = _art_filter_from_query({
            "q": ["pikachu"], "scene": ["beach,forest", "cave"], "weatherTime": ["rain"],
            "pokemonRole": ["main"], "priceMaxUsd": ["10"], "rarityBucket": [""],
        })
        self.assertEqual(mapped, {
            "text": "pikachu", "scene": ["beach", "forest", "cave"], "weather_time": ["rain"],
            "pokemon_role": "main", "price_max_usd": "10",
        })


if __name__ == "__main__":
    unittest.main()
