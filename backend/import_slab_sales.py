from __future__ import annotations

import json
import sys
from pathlib import Path

from catalog_tools import (
    apply_schema,
    connect,
    import_slab_sales,
    load_cards_json,
    load_slab_sales_file,
    resolve_catalog_json_path,
    seed_catalog,
)


def cli_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None
    index = sys.argv.index(flag)
    if index + 1 >= len(sys.argv):
        raise SystemExit(f"Missing value for {flag}")
    return sys.argv[index + 1]


def main() -> None:
    root = Path(__file__).resolve().parent
    repo_root = root.parent

    sales_file = cli_value("--file")
    if sales_file is None:
        raise SystemExit("Usage: python3 backend/import_slab_sales.py --file <sales.json|sales.csv> [--database-path ...] [--cards-file ...]")

    database_path = Path(cli_value("--database-path") or (root / "data" / "spotlight_scanner.sqlite"))
    database_path.parent.mkdir(parents=True, exist_ok=True)

    connection = connect(database_path)
    apply_schema(connection, root / "schema.sql")

    cards_file = cli_value("--cards-file")
    if cards_file is not None:
        cards_path = resolve_catalog_json_path(root, explicit_path=cards_file)
        seed_catalog(connection, load_cards_json(cards_path), repo_root)

    sales = load_slab_sales_file(Path(sales_file))
    summary = import_slab_sales(connection, sales)
    print(json.dumps({"summary": summary}, indent=2))


if __name__ == "__main__":
    main()
