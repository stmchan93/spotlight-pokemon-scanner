from __future__ import annotations

import json
import sys
from pathlib import Path

from catalog_tools import apply_schema, connect, load_cards_json, seed_catalog
from scrydex_adapter import ScrydexProvider, scrydex_credentials
from server import SpotlightScanService


def cli_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None
    index = sys.argv.index(flag)
    if index + 1 >= len(sys.argv):
        raise SystemExit(f"Missing value for {flag}")
    return sys.argv[index + 1]


def ensure_card_seeded(connection, repo_root: Path, cards_path: Path, card_id: str) -> None:
    row = connection.execute("SELECT 1 FROM cards WHERE id = ? LIMIT 1", (card_id,)).fetchone()
    if row:
        return

    cards = load_cards_json(cards_path)
    selected = [card for card in cards if card["id"] == card_id]
    if not selected:
        raise SystemExit(f"Card {card_id} was not found in {cards_path}")
    seed_catalog(connection, selected, repo_root)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    backend_root = repo_root / "backend"

    credentials = scrydex_credentials()
    if credentials is None:
        raise SystemExit(
            "Scrydex validation blocked: set SCRYDEX_API_KEY and SCRYDEX_TEAM_ID before running this command."
        )

    database_path_value = cli_value("--database-path")
    database_path = Path(database_path_value) if database_path_value else backend_root / "data" / "imported_scanner.sqlite"

    cards_file_value = cli_value("--cards-file")
    cards_path = Path(cards_file_value) if cards_file_value else backend_root / "catalog" / "pokemontcg" / "cards.json"
    if not cards_path.is_absolute():
        cards_path = repo_root / cards_path

    raw_card_id = cli_value("--raw-card") or "sv3-223"
    psa_card_id = cli_value("--psa-card") or "sv8-238"
    psa_grade = cli_value("--psa-grade") or "9"

    connection = connect(database_path)
    apply_schema(connection, backend_root / "schema.sql")
    ensure_card_seeded(connection, repo_root, cards_path, raw_card_id)
    ensure_card_seeded(connection, repo_root, cards_path, psa_card_id)

    provider = ScrydexProvider()
    raw_result = provider.refresh_raw_pricing(connection, raw_card_id)
    psa_result = provider.refresh_psa_pricing(connection, psa_card_id, psa_grade)
    connection.commit()

    service = SpotlightScanService(database_path, repo_root, cards_path=cards_path)
    try:
        result = {
            "scrydexConfigured": True,
            "databasePath": str(database_path),
            "cardsPath": str(cards_path),
            "rawCardID": raw_card_id,
            "rawValidated": raw_result.success,
            "rawProvider": raw_result.provider_id,
            "rawError": raw_result.error,
            "rawPayload": raw_result.payload,
            "rawDetail": service.card_detail(raw_card_id),
            "psaCardID": psa_card_id,
            "psaGrade": psa_grade,
            "psaValidated": psa_result.success,
            "psaProvider": psa_result.provider_id,
            "psaError": psa_result.error,
            "psaPayload": psa_result.payload,
            "psaDetail": service.card_detail(psa_card_id, grader="PSA", grade=psa_grade),
        }
        print(json.dumps(result, indent=2))
    finally:
        service.connection.close()
        connection.close()


if __name__ == "__main__":
    main()
