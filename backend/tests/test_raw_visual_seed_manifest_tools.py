from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_ROOT = REPO_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from build_raw_visual_seed_manifest import (  # noqa: E402
    TruthKey,
    build_card_queries,
    choose_mapping,
    printed_number_query_value,
    stripped_number_variants,
)
from scrydex_expansion_resolver import resolve_expansion_token, write_expansion_snapshot  # noqa: E402


class RawVisualSeedManifestToolTests(unittest.TestCase):
    def test_stripped_number_variants_preserve_printed_and_numeric_forms(self) -> None:
        self.assertEqual(stripped_number_variants("044"), ["044", "44"])
        self.assertEqual(stripped_number_variants("044/SM-P"), ["044", "44"])
        self.assertEqual(stripped_number_variants("SWSH184"), ["SWSH184", "184"])
        self.assertEqual(stripped_number_variants("GG30/GG70"), ["GG30", "30"])

    def test_printed_number_query_value_preserves_promo_hyphen(self) -> None:
        self.assertEqual(printed_number_query_value("044/SM-P"), "044/SM-P")
        self.assertEqual(printed_number_query_value(" 044 / SM-P "), "044/SM-P")

    def test_build_card_queries_prefers_resolved_expansion_id(self) -> None:
        truth = TruthKey("Charmander", "044", "SVP")
        queries = build_card_queries(truth, resolved_expansion={"id": "svp", "code": "PR-SV"})
        self.assertIn('name:"Charmander" number:"44" expansion.id:svp', queries)
        self.assertIn('name:"Charmander" printed_number:"044" expansion.id:svp', queries)
        self.assertIn('printed_number:"044" expansion.code:SVP', queries)

    @patch("scrydex_expansion_resolver.search_expansions")
    def test_resolve_expansion_token_aliases_gallery_sets(self, mock_search_expansions) -> None:
        mock_search_expansions.side_effect = lambda query, page_size=10: (
            [{"id": "swsh12pt5gg", "code": "CRZ", "name": "Crown Zenith Galarian Gallery", "series": "Sword & Shield", "language_code": "EN"}]
            if query == "id:swsh12pt5gg"
            else []
        )
        result = resolve_expansion_token("CRZ:GG", {}, allow_live_lookup=True)
        self.assertEqual(result["resolution"], "resolved")
        self.assertEqual(result["selected"]["id"], "swsh12pt5gg")

    def test_resolve_expansion_token_uses_snapshot_offline(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            snapshot_path = Path(tmp) / "snapshot.json"
            write_expansion_snapshot(
                snapshot_path,
                [
                    {
                        "id": "svp",
                        "code": "PR-SV",
                        "name": "Scarlet & Violet Black Star Promos",
                        "series": "Scarlet & Violet",
                        "language": "English",
                        "language_code": "EN",
                    }
                ],
            )
            result = resolve_expansion_token("SVP", {}, snapshot_path=snapshot_path, allow_live_lookup=False)
            self.assertEqual(result["resolution"], "resolved")
            self.assertEqual(result["selected"]["id"], "svp")

    @patch("build_raw_visual_seed_manifest.search_cards")
    @patch("build_raw_visual_seed_manifest.resolve_expansion_token")
    def test_choose_mapping_uses_resolved_expansion_id_queries(self, mock_resolve_expansion, mock_search_cards) -> None:
        mock_resolve_expansion.return_value = {
            "selected": {"id": "svp", "code": "PR-SV", "name": "Scarlet & Violet Black Star Promos"},
            "attempts": [{"query": 'id:svp', "resultCount": 1}],
            "candidateSummaries": [],
            "resolution": "resolved",
        }

        observed_queries: list[str] = []

        def fake_search_cards(query: str, api_key: str | None, page_size: int = 10, *, japanese: bool = False):
            del api_key, page_size
            observed_queries.append(f'{"ja" if japanese else "global"}:{query}')
            if not japanese and query == 'name:"Charmander" number:"44" expansion.id:svp':
                return [
                    {
                        "id": "svp-44",
                        "name": "Charmander",
                        "number": "044",
                        "set_id": "svp",
                        "set_ptcgo_code": "PR-SV",
                        "set_name": "Scarlet & Violet Black Star Promos",
                        "reference_image_url": "https://images.scrydex.com/pokemon/svp-44/large",
                        "source": "scrydex",
                    }
                ]
            return []

        mock_search_cards.side_effect = fake_search_cards
        result = choose_mapping(
            TruthKey("Charmander", "044", "SVP"),
            None,
            {},
            allow_legacy_set_code_queries=False,
        )
        self.assertTrue(result["providerSupported"])
        self.assertEqual(result["selected"]["providerCardId"], "svp-44")
        self.assertIn('global:name:"Charmander" number:"44" expansion.id:svp', observed_queries)


if __name__ == "__main__":
    unittest.main()
