from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from catalog_tools import (
    PROVIDER_SYNC_STATUS_FAILED,
    PROVIDER_SYNC_STATUS_SUCCEEDED,
    apply_schema,
    connect,
    start_provider_sync_run,
    update_provider_sync_run,
    upsert_catalog_card,
    utc_now,
)
from env_loader import load_backend_env_file
from scrydex_adapter import (
    SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
    SCRYDEX_PROVIDER,
    fetch_scrydex_cards_page,
    map_scrydex_catalog_card,
    persist_scrydex_daily_history_from_card_payload,
    persist_scrydex_all_graded_snapshots,
    persist_scrydex_raw_snapshot,
    scrydex_credentials,
)

load_backend_env_file(Path(__file__).resolve().parent / ".env")


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


def sync_scrydex_catalog(
    *,
    database_path: Path,
    repo_root: Path,
    page_size: int = 100,
    language: str | None = None,
    max_pages: int | None = None,
    scheduled_for: str | None = None,
) -> dict[str, Any]:
    backend_root = Path(__file__).resolve().parent
    connection = connect(database_path)
    apply_schema(connection, backend_root / "schema.sql")

    credentials = scrydex_credentials()
    if credentials is None:
        connection.close()
        raise SystemExit("Scrydex credentials are not configured")

    normalized_language = str(language or "").strip().lower() or "all"
    notes = {
        "language": normalized_language,
        "includePrices": True,
        "sameMachineCron": True,
    }
    run_id = start_provider_sync_run(
        connection,
        provider=SCRYDEX_PROVIDER,
        sync_scope=SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
        page_size=page_size,
        scheduled_for=scheduled_for,
        notes=notes,
    )
    connection.commit()

    totals = {
        "pagesFetched": 0,
        "cardsSeen": 0,
        "cardsUpserted": 0,
        "rawSnapshotsUpserted": 0,
        "gradedSnapshotsUpserted": 0,
    }
    request_type = f"catalog_sync_{normalized_language}"

    try:
        page = 1
        while True:
            cards = fetch_scrydex_cards_page(
                page=page,
                page_size=page_size,
                include_prices=True,
                language=None if normalized_language == "all" else normalized_language,
                request_type=request_type,
            )
            if not cards:
                break

            totals["pagesFetched"] += 1
            totals["cardsSeen"] += len(cards)

            imported_at = utc_now()
            for payload in cards:
                mapped_card = map_scrydex_catalog_card(payload)
                upsert_catalog_card(
                    connection,
                    mapped_card,
                    repo_root,
                    imported_at,
                    refresh_embeddings=False,
                )
                totals["cardsUpserted"] += 1
                if persist_scrydex_raw_snapshot(connection, str(mapped_card["id"]), payload, commit=False) is not None:
                    totals["rawSnapshotsUpserted"] += 1
                totals["gradedSnapshotsUpserted"] += persist_scrydex_all_graded_snapshots(
                    connection,
                    card_id=str(mapped_card["id"]),
                    payload=payload,
                    commit=False,
                )
                persist_scrydex_daily_history_from_card_payload(
                    connection,
                    card_id=str(mapped_card["id"]),
                    payload=payload,
                    commit=False,
                )

            connection.commit()
            update_provider_sync_run(
                connection,
                run_id,
                pages_fetched=totals["pagesFetched"],
                cards_seen=totals["cardsSeen"],
                cards_upserted=totals["cardsUpserted"],
                raw_snapshots_upserted=totals["rawSnapshotsUpserted"],
                graded_snapshots_upserted=totals["gradedSnapshotsUpserted"],
                estimated_credits_used=totals["pagesFetched"],
            )
            connection.commit()

            if len(cards) < page_size:
                break
            if max_pages is not None and totals["pagesFetched"] >= max_pages:
                break
            page += 1

        completed_at = utc_now()
        update_provider_sync_run(
            connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_SUCCEEDED,
            completed_at=completed_at,
            pages_fetched=totals["pagesFetched"],
            cards_seen=totals["cardsSeen"],
            cards_upserted=totals["cardsUpserted"],
            raw_snapshots_upserted=totals["rawSnapshotsUpserted"],
            graded_snapshots_upserted=totals["gradedSnapshotsUpserted"],
            estimated_credits_used=totals["pagesFetched"],
        )
        connection.commit()
        return {
            "runID": run_id,
            "provider": SCRYDEX_PROVIDER,
            "syncScope": SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
            "language": normalized_language,
            "pageSize": page_size,
            **totals,
            "estimatedCreditsUsed": totals["pagesFetched"],
            "completedAt": completed_at,
            "databasePath": str(database_path),
        }
    except Exception as exc:
        connection.rollback()
        update_provider_sync_run(
            connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_FAILED,
            completed_at=utc_now(),
            pages_fetched=totals["pagesFetched"],
            cards_seen=totals["cardsSeen"],
            cards_upserted=totals["cardsUpserted"],
            raw_snapshots_upserted=totals["rawSnapshotsUpserted"],
            graded_snapshots_upserted=totals["gradedSnapshotsUpserted"],
            estimated_credits_used=totals["pagesFetched"],
            error_text=str(exc),
        )
        connection.commit()
        raise
    finally:
        connection.close()


def main() -> None:
    backend_root = Path(__file__).resolve().parent
    repo_root = backend_root.parent
    database_path = Path(
        cli_value("--database-path")
        or str((backend_root / "data" / "spotlight_scanner.sqlite").resolve())
    )
    page_size = cli_int_value("--page-size", 100)
    max_pages_value = cli_value("--max-pages")
    max_pages = int(max_pages_value) if max_pages_value is not None else None
    language = cli_value("--language")
    scheduled_for = cli_value("--scheduled-for")
    summary = sync_scrydex_catalog(
        database_path=database_path,
        repo_root=repo_root,
        page_size=page_size,
        language=language,
        max_pages=max_pages,
        scheduled_for=scheduled_for,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
