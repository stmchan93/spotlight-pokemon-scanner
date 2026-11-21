#!/usr/bin/env python3
"""Re-embed specific cards' rows in the ACTIVE visual index, in place.

For rows embedded from a bad reference image (e.g. a card back cached before
Scrydex published the front). Per card: re-download the catalog image_url, run
the placeholder guard (known card backs + duplicate-bytes check against every
other cached reference), embed with the runtime encoder + adapter (same space
as the nightly append), and replace exactly that card's base row(s). Row count,
row order, and every other row are unchanged; the prior active npz + manifest
are kept as `<file><backup-suffix>`.

Run it with the backend's runtime env loaded (index/adapter paths come from
SPOTLIGHT_VISUAL_* exactly like the server), e.g. on a VM:

  cd ~/spotlight && (set -a; . ./.vm-runtime.conf; . "$SPOTLIGHT_RUNTIME_ENV_FILE"; . ./.vm-runtime.conf; set +a;
    .venv/bin/python tools/reembed_index_cards.py --card-ids me55-R,me55-G --dry-run)

The running server only sees new rows / denylist changes after a restart.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = REPO_ROOT  # VM layout: backend files live at the bundle root
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from visual_index_incremental import POKEMON_GAME, reembed_cards  # noqa: E402


def _short(sha: str | None) -> str:
    return sha or "-"


def _games_for(connection: sqlite3.Connection, card_ids: list[str]) -> dict[str, list[str]]:
    by_game: dict[str, list[str]] = defaultdict(list)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(cards)")}
    for cid in card_ids:
        game = POKEMON_GAME
        if "game" in columns:
            row = connection.execute("SELECT game FROM cards WHERE id = ?", (cid,)).fetchone()
            game = str((row[0] if row else None) or POKEMON_GAME).strip().lower() or POKEMON_GAME
        by_game[game].append(cid)
    return dict(by_game)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--card-ids", required=True, help="Comma-separated card ids, e.g. me55-R,me55-G")
    parser.add_argument(
        "--database-path",
        type=Path,
        default=Path(os.environ.get("SPOTLIGHT_DATABASE_PATH") or (BACKEND_ROOT / "data" / "spotlight_scanner.sqlite")),
    )
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    parser.add_argument("--dry-run", action="store_true", help="Download + guard only; write nothing.")
    parser.add_argument(
        "--remove-from-denylist",
        action="store_true",
        help="After a successful re-embed, remove exactly the replaced ids from placeholder_card_ids.json cardIds.",
    )
    parser.add_argument(
        "--backup-suffix",
        default=None,
        help="Backup suffix for the prior active files (default: .pre-reembed-<UTC stamp>.bak).",
    )
    args = parser.parse_args()

    card_ids = [cid.strip() for cid in args.card_ids.split(",") if cid.strip()]
    if not card_ids:
        parser.error("--card-ids is empty")
    backup_suffix = args.backup_suffix or (
        ".pre-reembed-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".bak"
    )

    from raw_visual_matcher import RawVisualMatcher

    matcher = RawVisualMatcher(repo_root=args.repo_root)
    # Read-only DB handle: this tool never writes the catalog.
    connection = sqlite3.connect(f"file:{args.database_path}?mode=ro", uri=True)

    def _logger(severity: str, message: str) -> None:
        print(f"[{severity}] {message}", file=sys.stderr)

    exit_code = 0
    try:
        for game, ids in _games_for(connection, card_ids).items():
            index = matcher.index_for_game(game)
            if index is None or not index.is_available():
                print(f"[reembed] game={game}: no active index on this box; skipped {ids}")
                exit_code = 1
                continue
            print(f"[reembed] game={game} index={index.npz_path} dryRun={args.dry_run}")
            result = reembed_cards(
                index=index,
                connection=connection,
                card_ids=ids,
                embed_images_fn=matcher.embed_reference_images,
                model_id=matcher.model_id,
                game=game,
                dry_run=args.dry_run,
                remove_from_denylist_on_success=args.remove_from_denylist,
                backup_suffix=backup_suffix,
                logger=_logger,
            )
            for card in result["cards"]:
                passes = card["status"] in {"replaced", "would_replace"}
                line = (
                    f"  {card['cardId']:<16} {_short(card.get('oldSha256'))} -> {_short(card.get('newSha256'))}"
                    f"  guard={'PASS' if passes else 'FAIL'}  status={card['status']}"
                )
                if card.get("reason"):
                    line += f" reason={card['reason']}"
                if card.get("sharedWith"):
                    line += f" sharedWith={','.join(card['sharedWith'])}"
                if card.get("error"):
                    line += f" error={card['error']}"
                print(line)
                if not passes:
                    exit_code = 1
            if not args.dry_run:
                print(
                    f"[reembed] replaced={result['replaced']} entryCount={result['entryCount']} "
                    f"artCrop={result.get('artCrop', '-')} denylistRemoved={result['denylistRemoved']} "
                    f"backupSuffix={backup_suffix if result['replaced'] else '-'}"
                )
            print(json.dumps(result, default=str), file=sys.stderr)
    finally:
        connection.close()
    if not args.dry_run:
        print("[reembed] restart the backend (sudo systemctl restart spotlight-backend) to serve the new rows.")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
