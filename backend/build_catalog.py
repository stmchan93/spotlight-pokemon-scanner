from __future__ import annotations

import sys
from pathlib import Path

from catalog_tools import apply_schema, connect, load_cards_json, resolve_catalog_json_path, seed_catalog


def cli_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None

    index = sys.argv.index(flag)
    if index + 1 >= len(sys.argv):
        raise SystemExit(f"Missing value for {flag}")

    return sys.argv[index + 1]


def main() -> None:
    backend_root = Path(__file__).resolve().parent
    repo_root = backend_root.parent
    data_directory = backend_root / "data"
    data_directory.mkdir(parents=True, exist_ok=True)

    database_path = Path(cli_value("--database-path")) if cli_value("--database-path") else data_directory / "spotlight_scanner.sqlite"
    schema_path = backend_root / "schema.sql"
    cards_path = resolve_catalog_json_path(
        backend_root,
        explicit_path=cli_value("--cards-file")
    )

    connection = connect(database_path)
    apply_schema(connection, schema_path)
    seed_catalog(connection, load_cards_json(cards_path), repo_root)
    connection.close()

    print(f"Catalog initialized at {database_path} using {cards_path}")


if __name__ == "__main__":
    main()
