from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from catalog_sync import CatalogSyncPaths, load_catalog_sync_state, run_catalog_sync_once, sleep_with_interrupt
from catalog_tools import resolve_catalog_json_path
from import_pokemontcg_catalog import default_images_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run scheduled Pokemon catalog sync and release preload tasks")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--cards-file", default=None)
    parser.add_argument("--state-path", default=None)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval-seconds", type=int, default=3600)
    parser.add_argument("--plan-only", action="store_true")
    return parser.parse_args()


def load_manifest(manifest_path: Path) -> dict:
    return json.loads(manifest_path.read_text())


def main() -> None:
    args = parse_args()
    backend_root = Path(__file__).resolve().parent
    repo_root = backend_root.parent
    manifest_path = Path(args.manifest)
    if not manifest_path.is_absolute():
        manifest_path = repo_root / manifest_path

    cards_path = resolve_catalog_json_path(backend_root, explicit_path=args.cards_file)
    state_path = Path(args.state_path) if args.state_path else (backend_root / "data" / "catalog_sync_state.json")
    if not state_path.is_absolute():
        state_path = repo_root / state_path

    paths = CatalogSyncPaths(
        cards_path=cards_path,
        images_dir=default_images_dir(),
        database_path=Path(args.database_path),
        schema_path=backend_root / "schema.sql",
        repo_root=repo_root,
        backend_root=backend_root,
    )
    manifest = load_manifest(manifest_path)

    while True:
        if args.plan_only:
            state = load_catalog_sync_state(state_path)
            from catalog_sync import build_catalog_sync_plan  # local import to keep CLI tiny

            plan = build_catalog_sync_plan(manifest, state, datetime.now(UTC))
            print(json.dumps({"manifest": str(manifest_path), "statePath": str(state_path), "plan": plan}, indent=2))
            return

        summary = run_catalog_sync_once(
            manifest=manifest,
            state_path=state_path,
            paths=paths,
            env=None,
        )
        print(json.dumps(summary, indent=2))

        if not args.watch:
            return

        sleep_with_interrupt(args.interval_seconds)


if __name__ == "__main__":
    main()
