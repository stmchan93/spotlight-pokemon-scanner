#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-test}"

if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN_OVERRIDE:-python3}"
fi

TEST_MODULES=(
  backend.tests.test_backend_reset_phase1
  backend.tests.test_raw_evidence_phase3
  backend.tests.test_raw_retrieval_phase4
  backend.tests.test_raw_decision_phase5
  backend.tests.test_pricing_phase6
  backend.tests.test_scan_logging_phase7
  backend.tests.test_pricing_utils
  backend.tests.test_pricing_provider
  backend.tests.test_fx_rates
  backend.tests.test_ebay_comps
  backend.tests.test_portfolio_imports
  backend.tests.test_sync_scrydex_catalog
  backend.tests.test_raw_visual_index
  backend.tests.test_raw_visual_model
  backend.tests.test_raw_visual_matcher
  backend.tests.test_visual_index_incremental
  backend.tests.test_scrydex_adapter_helpers
  backend.tests.test_server_helpers
  backend.tests.test_scan_artifact_store_helpers
  backend.tests.test_profile_avatar_upload
  backend.tests.test_post_media_serving
  backend.tests.test_post_media_upload
  backend.tests.test_post_media_purge
  backend.tests.test_social_moderation_worker
  backend.tests.test_moderation_queue
  backend.tests.test_scrydex_tool_scripts
  backend.tests.test_request_auth
  backend.tests.test_audit_release_config
  backend.tests.test_vm_sync_schedule
  backend.tests.test_vm_runtime_config
  backend.tests.test_auto_stub_sale
  backend.tests.test_sale_lifecycle
  backend.tests.test_card_transactions
  backend.tests.test_user_isolation
  backend.tests.test_account_deletion_storage
  backend.tests.test_public_profile_reads
  backend.tests.test_show_summary
  backend.tests.test_raw_pricing_matrix
  backend.tests.test_card_language_link
  backend.tests.test_card_language_linker
  backend.tests.test_day_change_condition_match
  backend.tests.test_card_likes
  backend.tests.test_multi_collection
  backend.tests.test_repair_orphaned_collections
  backend.tests.test_replace_deck_entry_collection
  backend.tests.test_whos_that_pokemon
  backend.tests.test_one_piece_catalog
  backend.tests.test_multi_game_visual_index
  backend.tests.test_synthetic_capture
  backend.tests.test_game_registry
  backend.tests.test_multi_game_catalog_scoping
  backend.tests.test_catalog_id_namespacing
  backend.tests.test_multi_game_pricing_paths
  backend.tests.test_multi_game_pricing_refresh
  # The catalog-read suites. Added when `game` became a required argument on
  # search_cards / get_cards_by_expansion: all three broke, and the gate stayed
  # green because they were never in this list. They cover the search surface
  # every multi-game change touches, and they run in well under a second.
  backend.tests.test_manual_card_search
  backend.tests.test_expansion_browser
  backend.tests.test_expansion_game_scoping
  backend.tests.test_rarity_buckets
)

run_targeted_tests() {
  "$PYTHON_BIN" -m unittest -v "${TEST_MODULES[@]}"
}

run_discover_tests() {
  "$PYTHON_BIN" -m unittest discover -v -s backend/tests -p 'test*.py'
}

run_coverage() {
  local run_mode="$1"

  if ! "$PYTHON_BIN" -m coverage --version >/dev/null 2>&1; then
    echo "coverage is not installed for $PYTHON_BIN" >&2
    echo "Install it with: $PYTHON_BIN -m pip install coverage" >&2
    exit 1
  fi

  rm -f "$REPO_ROOT/.coverage"

  case "$run_mode" in
    targeted)
      "$PYTHON_BIN" -m coverage run --source=backend -m unittest -v "${TEST_MODULES[@]}"
      ;;
    discover)
      "$PYTHON_BIN" -m coverage run --source=backend -m unittest discover -v -s backend/tests -p 'test*.py'
      ;;
    *)
      echo "Unknown coverage mode: $run_mode" >&2
      exit 1
      ;;
  esac

  "$PYTHON_BIN" -m coverage report --omit='backend/tests/*'
}

case "$MODE" in
  test)
    run_targeted_tests
    ;;
  coverage)
    run_coverage targeted
    ;;
  discover)
    run_discover_tests
    ;;
  coverage-discover)
    run_coverage discover
    ;;
  *)
    echo "Usage: bash backend/run_all_tests.sh [test|coverage|discover|coverage-discover]" >&2
    exit 1
    ;;
esac
