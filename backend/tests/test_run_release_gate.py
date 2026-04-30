from __future__ import annotations

import os
import unittest

from tools.run_release_gate import (
    build_deploy_command,
    build_mobile_command,
    build_default_smoke_query,
    candidate_matches_truth,
    deck_quantity_for,
    extract_deck_entries,
    resolve_smoke_env_value,
)


class RunReleaseGateTests(unittest.TestCase):
    def test_build_deploy_command_includes_optional_secrets_file(self) -> None:
        self.assertEqual(
            build_deploy_command("staging", "backend/.env.staging.secrets"),
            ["bash", "tools/deploy_backend.sh", "staging", "backend/.env.staging.secrets"],
        )

    def test_build_mobile_command_uses_direct_eas_wrapper(self) -> None:
        self.assertEqual(
            build_mobile_command("staging", "release"),
            ["bash", "tools/run_mobile_eas.sh", "staging", "release", "ios", "staging"],
        )

    def test_candidate_matches_truth_normalizes_case_and_hash_prefix(self) -> None:
        candidate = {
            "name": "Pikachu VMAX",
            "number": "#swsh286",
        }

        self.assertTrue(
            candidate_matches_truth(
                candidate,
                truth_name="pikachu vmax",
                truth_number="SWSH286",
            )
        )

    def test_build_default_smoke_query_uses_name_and_number(self) -> None:
        self.assertEqual(
            build_default_smoke_query("Pikachu VMAX", "SWSH286"),
            "Pikachu VMAX SWSH286",
        )

    def test_extract_deck_entries_supports_array_and_wrapped_payloads(self) -> None:
        wrapped = {"entries": [{"cardID": "card-1"}]}
        direct = [{"cardID": "card-2"}]

        self.assertEqual(extract_deck_entries(wrapped), [{"cardID": "card-1"}])
        self.assertEqual(extract_deck_entries(direct), [{"cardID": "card-2"}])

    def test_deck_quantity_for_sums_matching_condition_only(self) -> None:
        entries = [
            {"cardID": "card-1", "condition": "near_mint", "quantity": 2},
            {"cardID": "card-1", "condition": "damaged", "quantity": 5},
            {"cardID": "card-1", "condition": "near_mint", "quantity": 1},
            {"cardID": "card-2", "condition": "near_mint", "quantity": 9},
        ]

        self.assertEqual(deck_quantity_for(entries, card_id="card-1", condition_code="near_mint"), 3)

    def test_resolve_smoke_env_value_prefers_environment_specific_override(self) -> None:
        previous_specific = os.environ.get("SPOTLIGHT_STAGING_SMOKE_EMAIL")
        previous_generic = os.environ.get("SPOTLIGHT_SMOKE_EMAIL")
        try:
            os.environ["SPOTLIGHT_SMOKE_EMAIL"] = "generic@example.com"
            os.environ["SPOTLIGHT_STAGING_SMOKE_EMAIL"] = "staging@example.com"
            self.assertEqual(resolve_smoke_env_value("staging", "EMAIL"), "staging@example.com")
        finally:
            if previous_specific is None:
                os.environ.pop("SPOTLIGHT_STAGING_SMOKE_EMAIL", None)
            else:
                os.environ["SPOTLIGHT_STAGING_SMOKE_EMAIL"] = previous_specific
            if previous_generic is None:
                os.environ.pop("SPOTLIGHT_SMOKE_EMAIL", None)
            else:
                os.environ["SPOTLIGHT_SMOKE_EMAIL"] = previous_generic


if __name__ == "__main__":
    unittest.main()
