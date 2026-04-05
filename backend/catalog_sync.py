from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from catalog_tools import (
    apply_schema,
    connect,
    load_cards_json,
    log_catalog_sync_run,
    seed_catalog,
    utc_now,
)


def load_catalog_sync_state(state_path: Path) -> dict[str, Any]:
    if not state_path.exists():
        return {
            "lastFullSyncAt": None,
            "releaseSyncs": {},
            "runs": [],
        }

    try:
        payload = json.loads(state_path.read_text())
    except json.JSONDecodeError:
        return {
            "lastFullSyncAt": None,
            "releaseSyncs": {},
            "runs": [],
        }

    payload.setdefault("lastFullSyncAt", None)
    payload.setdefault("releaseSyncs", {})
    payload.setdefault("runs", [])
    return payload


def save_catalog_sync_state(state_path: Path, state: dict[str, Any]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True))


def parse_date_only(value: str | None) -> date | None:
    if not value:
        return None
    return date.fromisoformat(value)


def parse_datetime_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def active_release_preloads(manifest: dict[str, Any], today: date) -> list[dict[str, Any]]:
    active: list[dict[str, Any]] = []
    for item in manifest.get("releasePreloads", []):
        if not isinstance(item, dict):
            continue
        start_date = parse_date_only(item.get("startDate"))
        end_date = parse_date_only(item.get("endDate"))
        if start_date and today < start_date:
            continue
        if end_date and today > end_date:
            continue
        active.append(item)
    return active


def diff_catalog_snapshots(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> dict[str, int]:
    before_by_id = {str(card["id"]): card for card in before}
    after_by_id = {str(card["id"]): card for card in after}

    added = 0
    updated = 0
    for card_id, after_card in after_by_id.items():
        before_card = before_by_id.get(card_id)
        if before_card is None:
            added += 1
        elif before_card != after_card:
            updated += 1

    return {
        "added": added,
        "updated": updated,
        "beforeCount": len(before_by_id),
        "afterCount": len(after_by_id),
    }


def should_run_interval(last_run_at: str | None, *, now: datetime, interval_hours: int) -> bool:
    if interval_hours <= 0:
        return False
    if last_run_at is None:
        return True
    last_run = parse_datetime_utc(last_run_at)
    if last_run is None:
        return True
    return (now - last_run).total_seconds() >= interval_hours * 3600


def build_catalog_sync_plan(manifest: dict[str, Any], state: dict[str, Any], now: datetime) -> dict[str, Any]:
    full_interval_hours = int(manifest.get("fullSyncIntervalHours", 24))
    release_interval_hours = int(manifest.get("releaseSyncIntervalHours", 6))
    release_syncs = state.get("releaseSyncs", {})

    release_tasks = []
    for item in active_release_preloads(manifest, now.date()):
        preload_id = str(item.get("id") or item.get("name") or item.get("query") or "release_preload")
        if should_run_interval(release_syncs.get(preload_id), now=now, interval_hours=release_interval_hours):
            release_tasks.append(
                {
                    "id": preload_id,
                    "name": item.get("name") or preload_id,
                    "query": item.get("query"),
                    "cardIDs": list(item.get("cardIDs") or []),
                }
            )

    return {
        "runFullSync": should_run_interval(state.get("lastFullSyncAt"), now=now, interval_hours=full_interval_hours),
        "fullQuery": manifest.get("fullQuery"),
        "maxCards": int(manifest.get("maxCards", 0) or 0),
        "pageSize": int(manifest.get("pageSize", 250)),
        "sleepSeconds": float(manifest.get("sleepSeconds", 0.2)),
        "downloadImages": bool(manifest.get("downloadImages", True)),
        "releaseTasks": release_tasks,
    }


@dataclass(frozen=True)
class CatalogSyncPaths:
    cards_path: Path
    images_dir: Path
    database_path: Path
    schema_path: Path
    repo_root: Path
    backend_root: Path


def _importer_command(
    *,
    backend_root: Path,
    cards_path: Path,
    images_dir: Path,
    query: str | None,
    card_ids: list[str] | None,
    max_cards: int,
    page_size: int,
    sleep_seconds: float,
    download_images: bool,
) -> list[str]:
    command = [
        sys.executable,
        str(backend_root / "import_pokemontcg_catalog.py"),
        "--catalog-json",
        str(cards_path),
        "--images-dir",
        str(images_dir),
        "--page-size",
        str(page_size),
        "--sleep-seconds",
        str(sleep_seconds),
    ]
    if not download_images:
        command.append("--skip-image-download")
    if max_cards > 0:
        command.extend(["--max-cards", str(max_cards)])
    if query:
        command.extend(["--query", query])
    if card_ids:
        for card_id in card_ids:
            command.extend(["--card-id", card_id])
        command.append("--exact-only")
    return command


def run_importer_command(command: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


def reseed_database(paths: CatalogSyncPaths) -> None:
    connection = connect(paths.database_path)
    apply_schema(connection, paths.schema_path)
    seed_catalog(connection, load_cards_json(paths.cards_path), paths.repo_root)
    connection.close()


def execute_catalog_sync_step(
    *,
    paths: CatalogSyncPaths,
    sync_mode: str,
    trigger_source: str,
    query_text: str | None,
    card_ids: list[str] | None,
    max_cards: int,
    page_size: int,
    sleep_seconds: float,
    download_images: bool,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    before_cards = load_cards_json(paths.cards_path) if paths.cards_path.exists() else []
    started_at = utc_now()
    command = _importer_command(
        backend_root=paths.backend_root,
        cards_path=paths.cards_path,
        images_dir=paths.images_dir,
        query=query_text,
        card_ids=card_ids,
        max_cards=max_cards,
        page_size=page_size,
        sleep_seconds=sleep_seconds,
        download_images=download_images,
    )
    result = run_importer_command(command, env=env)

    connection = connect(paths.database_path)
    apply_schema(connection, paths.schema_path)

    if result.returncode != 0:
        log_catalog_sync_run(
            connection,
            started_at=started_at,
            completed_at=utc_now(),
            sync_mode=sync_mode,
            trigger_source=trigger_source,
            query_text=query_text if query_text else ",".join(card_ids or []),
            status="failed",
            cards_before=len(before_cards),
            cards_after=len(before_cards),
            cards_added=0,
            cards_updated=0,
            summary={"stderr": result.stderr, "stdout": result.stdout},
            error_text=result.stderr.strip() or result.stdout.strip() or "catalog import failed",
        )
        connection.close()
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "catalog import failed")

    reseed_database(paths)
    after_cards = load_cards_json(paths.cards_path) if paths.cards_path.exists() else []
    diff = diff_catalog_snapshots(before_cards, after_cards)
    summary = {
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
        "cardsAdded": diff["added"],
        "cardsUpdated": diff["updated"],
    }
    log_catalog_sync_run(
        connection,
        started_at=started_at,
        completed_at=utc_now(),
        sync_mode=sync_mode,
        trigger_source=trigger_source,
        query_text=query_text if query_text else ",".join(card_ids or []),
        status="success",
        cards_before=diff["beforeCount"],
        cards_after=diff["afterCount"],
        cards_added=diff["added"],
        cards_updated=diff["updated"],
        summary=summary,
    )
    connection.close()

    return {
        "syncMode": sync_mode,
        "queryText": query_text,
        "cardIDs": card_ids or [],
        "cardsAdded": diff["added"],
        "cardsUpdated": diff["updated"],
        "cardsAfter": diff["afterCount"],
    }


def run_catalog_sync_once(
    *,
    manifest: dict[str, Any],
    state_path: Path,
    paths: CatalogSyncPaths,
    env: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    current_time = now or datetime.now(UTC)
    state = load_catalog_sync_state(state_path)
    plan = build_catalog_sync_plan(manifest, state, current_time)
    runs: list[dict[str, Any]] = []

    if plan["runFullSync"] and plan.get("fullQuery"):
        result = execute_catalog_sync_step(
            paths=paths,
            sync_mode="full_sync",
            trigger_source="scheduler",
            query_text=str(plan["fullQuery"]),
            card_ids=None,
            max_cards=int(plan["maxCards"]),
            page_size=int(plan["pageSize"]),
            sleep_seconds=float(plan["sleepSeconds"]),
            download_images=bool(plan["downloadImages"]),
            env=env,
        )
        runs.append(result)
        state["lastFullSyncAt"] = utc_now()

    for task in plan["releaseTasks"]:
        result = execute_catalog_sync_step(
            paths=paths,
            sync_mode="release_preload",
            trigger_source="scheduler",
            query_text=task.get("query"),
            card_ids=task.get("cardIDs") or None,
            max_cards=int(plan["maxCards"]),
            page_size=int(plan["pageSize"]),
            sleep_seconds=float(plan["sleepSeconds"]),
            download_images=bool(plan["downloadImages"]),
            env=env,
        )
        runs.append(result)
        state.setdefault("releaseSyncs", {})[task["id"]] = utc_now()

    if not runs:
        runs.append({"syncMode": "skipped", "reason": "No sync steps due"})

    state.setdefault("runs", []).append(
        {
            "ranAt": utc_now(),
            "summary": runs,
        }
    )
    state["runs"] = state["runs"][-20:]
    save_catalog_sync_state(state_path, state)
    return {
        "plan": plan,
        "runs": runs,
        "statePath": str(state_path),
    }


def sleep_with_interrupt(seconds: int) -> None:
    time.sleep(max(0, seconds))
