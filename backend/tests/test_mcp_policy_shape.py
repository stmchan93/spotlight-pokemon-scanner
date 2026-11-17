import unittest

from mcp_server.policy import USER_POLICY


class UserPolicyKeepsToolPayloadsTest(unittest.TestCase):
    """shape() drops unlisted keys on any dict with card_id; whole payloads vanished before."""

    def test_price_history_points_survive(self):
        payload = {
            "card_id": "base1-4", "condition": "NM", "variant": "Unlimited Holofoil",
            "points": [{"date": "2026-11-08", "usd": 987.13}], "source": "tcgplayer",
            "sources": [{"source": "tcgplayer", "from": "2026-08-07", "through": "2026-11-08"}],
            "as_of": "2026-11-08", "days_since_as_of": 2, "available_variants": ["Unlimited Holofoil"],
            "grader": None, "grade": None,
        }
        self.assertEqual(USER_POLICY.shape(payload), payload)

    def test_mover_fields_survive(self):
        mover = {"card_id": "pcgp_ja-40", "variant": "Promo", "baseline_date": "2026-01-01",
                 "baseline_price_usd": 60.0, "change_usd": 0.0, "change_pct": 0.0}
        self.assertEqual(USER_POLICY.shape({"top_losers": [mover]}), {"top_losers": [mover]})


if __name__ == "__main__":
    unittest.main()
