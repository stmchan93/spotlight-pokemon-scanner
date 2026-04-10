from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from pokemontcg_api_client import (  # noqa: E402
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    fetch_card_by_id,
    search_cards,
    search_remote_raw_candidates,
)


class PokemonTcgApiClientTests(unittest.TestCase):
    def _mock_response(self, payload: dict[str, object]) -> MagicMock:
        response = MagicMock()
        response.read.return_value = json.dumps(payload).encode("utf-8")
        return response

    def test_fetch_card_by_id_uses_default_timeout(self) -> None:
        with patch("pokemontcg_api_client.urlopen") as urlopen_mock:
            urlopen_mock.return_value.__enter__.return_value = self._mock_response(
                {"data": {"id": "pgo-11", "name": "Radiant Charizard"}}
            )

            card = fetch_card_by_id("pgo-11", "token")

        self.assertEqual(card["id"], "pgo-11")
        self.assertEqual(urlopen_mock.call_args.kwargs["timeout"], DEFAULT_REQUEST_TIMEOUT_SECONDS)

    def test_search_cards_allows_explicit_timeout_override(self) -> None:
        with patch("pokemontcg_api_client.urlopen") as urlopen_mock:
            urlopen_mock.return_value.__enter__.return_value = self._mock_response(
                {"data": [{"id": "pgo-11", "name": "Radiant Charizard"}]}
            )

            cards = search_cards('number:"11"', "token", timeout=2)

        self.assertEqual(cards[0]["id"], "pgo-11")
        self.assertEqual(urlopen_mock.call_args.kwargs["timeout"], 2)

    def test_search_remote_raw_candidates_records_query_failures(self) -> None:
        with patch("pokemontcg_api_client.search_cards") as search_cards_mock:
            search_cards_mock.side_effect = [
                [{"id": "gym1-60", "name": "Sabrina's Slowbro"}],
                RuntimeError("boom"),
            ]

            result = search_remote_raw_candidates(
                ['name:"Sabrina\'s Slowbro"', 'number:"60"'],
                "token",
                page_size=10,
            )

        self.assertEqual(result.cards[0]["id"], "gym1-60")
        self.assertEqual(result.attempts[0]["count"], 1)
        self.assertIsNone(result.attempts[0]["error"])
        self.assertEqual(result.attempts[1]["count"], 0)
        self.assertEqual(result.attempts[1]["error"], "boom")


if __name__ == "__main__":
    unittest.main()
