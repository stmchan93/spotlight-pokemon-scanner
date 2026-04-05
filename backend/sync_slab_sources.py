from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from slab_source_sync import manifest_sync_status, run_slab_source_sync_loop, sync_slab_sources_once


def cli_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None
    index = sys.argv.index(flag)
    if index + 1 >= len(sys.argv):
        raise SystemExit(f"Missing value for {flag}")
    return sys.argv[index + 1]


def cli_int_value(flag: str, default: int) -> int:
    value = cli_value(flag)
    return int(value) if value is not None else default


def main() -> None:
    backend_root = Path(__file__).resolve().parent
    repo_root = backend_root.parent

    manifest_value = cli_value("--manifest") or os.environ.get("SPOTLIGHT_SLAB_SOURCE_MANIFEST")
    if not manifest_value:
        raise SystemExit(
            "Usage: python3 backend/sync_slab_sources.py --manifest <manifest.json> "
            "[--database-path ...] [--cards-file ...] [--state-path ...] [--watch] [--validate] [--interval-seconds 900]"
        )

    manifest_path = Path(manifest_value)
    if not manifest_path.is_absolute():
        manifest_path = repo_root / manifest_path

    database_path_value = cli_value("--database-path") or os.environ.get("SPOTLIGHT_DATABASE_PATH")
    database_path = Path(database_path_value) if database_path_value else backend_root / "data" / "spotlight_scanner.sqlite"

    state_path_value = cli_value("--state-path") or os.environ.get("SPOTLIGHT_SLAB_SYNC_STATE_PATH")
    state_path = Path(state_path_value) if state_path_value else backend_root / "data" / "slab_source_sync_state.json"

    cards_file = cli_value("--cards-file") or os.environ.get("SPOTLIGHT_CATALOG_PATH")

    if "--validate" in sys.argv:
        print(json.dumps({"status": manifest_sync_status(manifest_path)}, indent=2))
        return

    if "--watch" in sys.argv:
        run_slab_source_sync_loop(
            database_path=database_path,
            repo_root=repo_root,
            manifest_path=manifest_path,
            interval_seconds=cli_int_value("--interval-seconds", int(os.environ.get("SPOTLIGHT_SLAB_SYNC_INTERVAL_SECONDS", "900"))),
            cards_file=cards_file,
            state_path=state_path,
        )
        return

    summary = sync_slab_sources_once(
        database_path=database_path,
        repo_root=repo_root,
        manifest_path=manifest_path,
        cards_file=cards_file,
        state_path=state_path,
    )
    print(json.dumps({"summary": summary}, indent=2))


if __name__ == "__main__":
    main()
