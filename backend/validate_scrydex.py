from __future__ import annotations

import json
import sys

from scrydex_adapter import SCRYDEX_BASE_URL, scrydex_credentials, scrydex_request_url


def cli_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None
    index = sys.argv.index(flag)
    if index + 1 >= len(sys.argv):
        raise SystemExit(f"Missing value for {flag}")
    return sys.argv[index + 1]


def main() -> None:
    database_path = cli_value("--database-path")
    card_id = cli_value("--card-id") or "base1-4"
    credentials = scrydex_credentials()
    payload = {
        "scrydexConfigured": credentials is not None,
        "databasePath": database_path,
        "baseURL": SCRYDEX_BASE_URL,
        "sampleCardURL": scrydex_request_url(f"/pokemon/v1/cards/{card_id}", include="prices", casing="snake"),
        "note": "Scrydex is preserved as a thin provider shell in the temporary raw-only backend build.",
    }
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
