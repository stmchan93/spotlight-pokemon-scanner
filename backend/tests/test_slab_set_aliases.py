from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import slab_set_aliases
import server


class SlabSetAliasesTests(unittest.TestCase):
    def setUp(self) -> None:
        slab_set_aliases._load_alias_entries.cache_clear()

    def tearDown(self) -> None:
        slab_set_aliases._load_alias_entries.cache_clear()

    def test_missing_alias_file_returns_empty_alias_set(self) -> None:
        with patch.object(
            slab_set_aliases.Path,
            "read_text",
            side_effect=FileNotFoundError("missing"),
        ):
            self.assertEqual(slab_set_aliases._load_alias_entries(), ())

    def test_loader_falls_back_to_alternate_alias_path(self) -> None:
        primary_path = Path("/tmp/primary-slab-set-aliases.json")
        fallback_path = Path("/tmp/fallback-slab-set-aliases.json")

        def fake_read_text(path: Path, *, encoding: str = "utf-8") -> str:
            self.assertEqual(encoding, "utf-8")
            if path == primary_path:
                raise FileNotFoundError("missing primary")
            if path == fallback_path:
                return '[{"aliases":["POKEMON MBG"],"scopes":["pokemon mega brave"]}]'
            raise AssertionError(f"Unexpected path: {path}")

        with patch.object(
            slab_set_aliases,
            "_alias_entry_paths",
            return_value=(primary_path, fallback_path),
        ), patch.object(
            slab_set_aliases.Path,
            "read_text",
            autospec=True,
            side_effect=fake_read_text,
        ):
            self.assertEqual(
                slab_set_aliases._load_alias_entries(),
                (
                    {
                        "aliases": ["POKEMON MBG"],
                        "scopes": ["pokemon mega brave"],
                    },
                ),
            )


class CrossLanguageAliasResolutionTests(unittest.TestCase):
    """CLF/CLL/CLK aliases resolve to English set IDs via cross_language_set_ids."""

    def setUp(self) -> None:
        slab_set_aliases._load_alias_entries.cache_clear()

    def tearDown(self) -> None:
        slab_set_aliases._load_alias_entries.cache_clear()

    def _resolve(self, label_text: str) -> slab_set_aliases.SlabSetAliasResolution:
        return slab_set_aliases.resolve_slab_set_aliases(
            grader="PSA",
            label_text=label_text,
        )

    def test_clf_jp_resolves_to_clv_with_cross_language_set_id(self) -> None:
        result = self._resolve("2023 POKEMON CLF JP CHANSEY #015 GEM MT 10")
        self.assertEqual(result.scopes, ("clv",))
        self.assertEqual(result.cross_language_set_ids, ("clv",))
        self.assertEqual(result.source, "psa_alias_map")

    def test_clf_jp_variant_labels_all_resolve(self) -> None:
        for label in ("CLF JP", "CLF JPN", "POKEMON CLF JP"):
            with self.subTest(label=label):
                result = self._resolve(f"2023 {label} CHANSEY #015")
                self.assertEqual(result.scopes, ("clv",))
                self.assertEqual(result.cross_language_set_ids, ("clv",))

    def test_cll_jp_resolves_to_clc(self) -> None:
        result = self._resolve("2023 POKEMON CLL JP CHARIZARD #006 GEM MT 10")
        self.assertEqual(result.scopes, ("clc",))
        self.assertEqual(result.cross_language_set_ids, ("clc",))

    def test_clk_jp_resolves_to_clb(self) -> None:
        result = self._resolve("2023 POKEMON CLK JP BLASTOISE #009 GEM MT 10")
        self.assertEqual(result.scopes, ("clb",))
        self.assertEqual(result.cross_language_set_ids, ("clb",))

    def test_regular_alias_has_empty_cross_language_set_ids(self) -> None:
        # Pokemon GO alias should NOT set cross_language_set_ids
        result = self._resolve("2022 POKEMON GO PIKACHU #001")
        self.assertEqual(result.scopes, ("Pokemon GO", "PGO"))
        self.assertEqual(result.cross_language_set_ids, ())

    def test_non_psa_grader_returns_no_alias(self) -> None:
        result = slab_set_aliases.resolve_slab_set_aliases(
            grader="CGC",
            label_text="2023 POKEMON CLF JP CHANSEY #015 GEM MT 10",
        )
        self.assertEqual(result.scopes, ())
        self.assertEqual(result.cross_language_set_ids, ())

    def test_unmatched_label_has_empty_cross_language_set_ids(self) -> None:
        result = self._resolve("2023 POKEMON SV PIKACHU #001 GEM MT 10")
        self.assertEqual(result.cross_language_set_ids, ())


class StripCrossLanguageSetSuffixTests(unittest.TestCase):
    """_strip_cross_language_set_suffix removes deck name from Classic set names."""

    def test_venusaur_suffix_stripped(self) -> None:
        self.assertEqual(
            server._strip_cross_language_set_suffix("Pokémon TCG Classic - Venusaur"),
            "Pokémon TCG Classic",
        )

    def test_charizard_suffix_stripped(self) -> None:
        self.assertEqual(
            server._strip_cross_language_set_suffix("Pokémon TCG Classic - Charizard"),
            "Pokémon TCG Classic",
        )

    def test_blastoise_suffix_stripped(self) -> None:
        self.assertEqual(
            server._strip_cross_language_set_suffix("Pokémon TCG Classic - Blastoise"),
            "Pokémon TCG Classic",
        )

    def test_non_classic_set_unchanged(self) -> None:
        self.assertEqual(
            server._strip_cross_language_set_suffix("Scarlet & Violet"),
            "Scarlet & Violet",
        )

    def test_classic_without_suffix_unchanged(self) -> None:
        self.assertEqual(
            server._strip_cross_language_set_suffix("Pokémon TCG Classic"),
            "Pokémon TCG Classic",
        )

    def test_empty_string_unchanged(self) -> None:
        self.assertEqual(server._strip_cross_language_set_suffix(""), "")


if __name__ == "__main__":
    unittest.main()
