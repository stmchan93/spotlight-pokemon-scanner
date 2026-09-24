""""More like this" on the card page: art-embedding neighbours per card.

The nightly job (``compute_similar_cards``, run by ``run_similar_cards_vm.sh``,
never inside the server process) takes each game's ACTIVE visual index — the
same npz + manifest the scanner matches against — and stores every card's
top-K cosine neighbours in ``card_similar``. The npz rows are already
adapter-projected, so they are only L2-normalised here, never re-projected.
Card-back placeholder ids (``placeholder_card_ids.json`` next to the manifest)
are dropped both as queries and as neighbours.

``build_similar_cards_payload`` serves one card's rows split three ways:

- ``goesWith``: the best neighbour from the SAME set with a DIFFERENT base name
  at score >= GOES_WITH_MIN_SCORE (Latios ☆ → Latias ☆), else null.
- ``sameName``: neighbours sharing the normalised base name (other printings).
- ``sameLookCheaper``: the rest, priced below this card (empty when unpriced).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from catalog_tools import SUPPORTED_GAMES, _table_columns, _table_exists, utc_now
from feed_prices import raw_price_changes, round_money

DEFAULT_TOP_K = 20
# 256 query rows × 45k cards (scores + argpartition's copy + int64 indices) is
# ~180MB per chunk; the whole Pokémon run peaks at ~0.8GB RSS (measured
# 2026-09-23), under the ~1.5GB budget next to the server on an e2-standard-2.
DEFAULT_CHUNK_ROWS = 256
GOES_WITH_MIN_SCORE = 0.75
ROW_LIMIT = 10
PLACEHOLDER_DENYLIST_FILENAME = "placeholder_card_ids.json"
GAME_POKEMON = "pokemon"
DEFAULT_VISUAL_MODEL_ID = "google/siglip2-base-patch16-384"


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS card_similar (
            card_id TEXT NOT NULL,
            rank INTEGER NOT NULL,
            neighbour_id TEXT NOT NULL,
            score REAL NOT NULL,
            game TEXT NOT NULL,
            computed_at TEXT NOT NULL,
            PRIMARY KEY (card_id, rank)
        ) WITHOUT ROWID
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_card_similar_game ON card_similar(game)")


# --- index resolution ------------------------------------------------------


def _sanitize_model_slug(model_id: str) -> str:
    # Mirrors raw_visual_matcher.sanitize_model_slug without importing torch.
    slug = str(model_id or "").split("/")[-1].strip().lower()
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in slug)


def _resolve(repo_root: Path, value: str | None, default: Path) -> Path:
    if not value:
        return default
    candidate = Path(value)
    return candidate if candidate.is_absolute() else (repo_root / candidate).resolve()


def resolve_index_paths_by_game(
    repo_root: Path, env: dict[str, str] | None = None
) -> dict[str, tuple[Path, Path]]:
    """{game: (npz, manifest)} for every game whose active index exists, using
    the same env overrides and filenames as RawVisualMatcher."""
    env = dict(os.environ) if env is None else env
    root = repo_root / "backend" / "data" / "visual-index"
    model_slug = _sanitize_model_slug(env.get("SPOTLIGHT_VISUAL_MODEL_ID") or DEFAULT_VISUAL_MODEL_ID)
    out: dict[str, tuple[Path, Path]] = {}
    for game in SUPPORTED_GAMES:
        if game == GAME_POKEMON:
            npz = _resolve(repo_root, env.get("SPOTLIGHT_VISUAL_INDEX_NPZ_PATH"),
                           root / "visual_index_active_clip-vit-base-patch32.npz")
            manifest = _resolve(repo_root, env.get("SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH"),
                                root / "visual_index_active_manifest.json")
        else:
            suffix = game.upper()
            npz = _resolve(repo_root, env.get(f"SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_{suffix}"),
                           root / f"visual_index_active_{game}_{model_slug}.npz")
            manifest = _resolve(repo_root, env.get(f"SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH_{suffix}"),
                                root / f"visual_index_active_{game}_manifest.json")
        if npz.exists() and manifest.exists():
            out[game] = (npz, manifest)
    return out


def _read_denylist(manifest_path: Path) -> frozenset[str]:
    try:
        payload = json.loads((manifest_path.parent / PLACEHOLDER_DENYLIST_FILENAME).read_text())
        return frozenset(str(c) for c in payload.get("cardIds", []) if c)
    except (OSError, ValueError, AttributeError, TypeError):
        return frozenset()


def _load_index(npz_path: Path, manifest_path: Path) -> tuple[np.ndarray, list[str]]:
    manifest = json.loads(manifest_path.read_text())
    ids = [str(e.get("providerCardId") or "") for e in manifest.get("entries", []) if isinstance(e, dict)]
    with np.load(npz_path) as data:
        matrix = np.asarray(data["embeddings"], dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] != len(ids):
        raise ValueError(f"index/manifest mismatch: {matrix.shape} vs {len(ids)} entries ({npz_path})")
    return matrix, ids


# --- neighbour compute -----------------------------------------------------


def nearest_neighbours(
    matrix: np.ndarray,
    ids: list[str],
    *,
    top_k: int = DEFAULT_TOP_K,
    exclude_ids: frozenset[str] = frozenset(),
    chunk_rows: int = DEFAULT_CHUNK_ROWS,
    copy: bool = True,
) -> dict[str, list[tuple[str, float]]]:
    """{card_id: [(neighbour_id, cosine), ...]} best first, excluding self and
    ``exclude_ids`` (as queries and as neighbours). Scores in chunks of
    ``chunk_rows`` query rows so peak memory is chunk × N, not N × N.
    ``copy=False`` normalises ``matrix`` in place (the nightly job owns it)."""
    work = np.array(matrix, dtype=np.float32, copy=True) if copy else np.asarray(matrix, dtype=np.float32)
    np.nan_to_num(work, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    norms = np.linalg.norm(work, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    work /= norms
    excluded = np.array([not card_id or card_id in exclude_ids for card_id in ids], dtype=bool)
    excluded_cols = np.flatnonzero(excluded)
    query_rows = np.flatnonzero(~excluded)
    n = work.shape[0]
    # Over-fetch so masked placeholders and duplicate rows of one card cannot starve top_k.
    fetch = min(n, top_k + 4 + excluded_cols.size)
    out: dict[str, list[tuple[str, float]]] = {}
    for start in range(0, query_rows.size, chunk_rows):
        rows = query_rows[start : start + chunk_rows]
        scores = work[rows] @ work.T
        scores[np.arange(rows.size), rows] = -np.inf  # self
        if excluded_cols.size:
            scores[:, excluded_cols] = -np.inf
        if fetch < n:
            part = np.argpartition(scores, -fetch, axis=1)[:, -fetch:]
        else:
            part = np.tile(np.arange(n), (rows.size, 1))
        part_scores = np.take_along_axis(scores, part, axis=1)
        del scores
        order = np.argsort(-part_scores, axis=1)
        best = np.take_along_axis(part, order, axis=1)
        best_scores = np.take_along_axis(part_scores, order, axis=1)
        for offset, row in enumerate(rows):
            card_id = ids[int(row)]
            if card_id in out:
                continue
            seen: set[str] = {card_id}
            neighbours: list[tuple[str, float]] = []
            for col, score in zip(best[offset].tolist(), best_scores[offset].tolist()):
                if score == float("-inf"):
                    break
                neighbour = ids[col]
                if neighbour in seen:
                    continue
                seen.add(neighbour)
                neighbours.append((neighbour, score))
                if len(neighbours) >= top_k:
                    break
            out[card_id] = neighbours
    return out


@dataclass(frozen=True)
class GameRun:
    game: str
    cards: int
    rows: int
    seconds: float


def compute_similar_cards(
    connection: sqlite3.Connection,
    *,
    index_paths_by_game: dict[str, tuple[Path, Path]],
    top_k: int = DEFAULT_TOP_K,
    chunk_rows: int = DEFAULT_CHUNK_ROWS,
) -> dict[str, Any]:
    """Recompute and store neighbours for every game in ``index_paths_by_game``.

    Each game's matrix work finishes before its write transaction opens, so the
    database write lock is held only for that game's delete + insert and the
    live server keeps writing scans while the compute runs."""
    ensure_schema(connection)
    connection.commit()
    runs: list[GameRun] = []
    computed_at = utc_now()
    for game, (npz_path, manifest_path) in sorted(index_paths_by_game.items()):
        started = time.perf_counter()
        matrix, ids = _load_index(Path(npz_path), Path(manifest_path))
        neighbours = nearest_neighbours(
            matrix, ids, top_k=top_k, exclude_ids=_read_denylist(Path(manifest_path)),
            chunk_rows=chunk_rows, copy=False,
        )
        del matrix
        # One short transaction per game: readers see the old rows or the new
        # ones, never a half-written game.
        with connection:
            connection.execute("DELETE FROM card_similar WHERE game = ?", (game,))
            connection.executemany(
                "INSERT OR REPLACE INTO card_similar (card_id, rank, neighbour_id, score, game, computed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    (card_id, rank, neighbour, round(score, 5), game, computed_at)
                    for card_id, rows in neighbours.items()
                    for rank, (neighbour, score) in enumerate(rows, start=1)
                ),
            )
        runs.append(GameRun(game, len(neighbours), sum(len(v) for v in neighbours.values()),
                            time.perf_counter() - started))
        del neighbours
    return {
        "computedAt": computed_at,
        "games": {r.game: {"cards": r.cards, "rows": r.rows, "seconds": round(r.seconds, 2)} for r in runs},
    }


# --- base-name normaliser ----------------------------------------------------

# Trailing mechanic / rarity markers, stripped repeatedly: "Charizard VMAX",
# "Garchomp C LV.X", "Latios ☆", "Pikachu ◇", "Rayquaza δ", "Mewtwo Star".
_SUFFIX_TOKENS = {
    "ex", "gx", "v", "vmax", "vstar", "v-union", "lv.x", "lvx", "break", "prime", "legend",
    "star", "☆", "★", "δ", "◇", "♢", "c", "g", "gl", "fb", "e4",
}
# Hyphen-joined suffixes ("Charizard-EX", "Pikachu & Zekrom-GX"); plain hyphens
# stay (Ho-Oh, Porygon-Z, Kommo-o).
_HYPHEN_SUFFIX = re.compile(r"-(?:ex|gx|v|vmax|vstar|v-union)$", re.IGNORECASE)
_PREFIX_TOKENS = {"dark", "light", "shining", "radiant", "mega", "m", "primal"}
# Owner prefix from Gym Heroes to Destined Rivals: "Misty's", "Lt. Surge's",
# "Team Rocket's", "Rocket's", "Cynthia's". Farfetch'd has no "'s ".
_POSSESSIVE_PREFIX = re.compile(r"^[^'’]{1,24}?['’]s\s+")
_PARENS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")


def base_name(name: str | None, *, game: str | None = GAME_POKEMON, supertype: str | None = None) -> str:
    """Display base name: "Team Rocket's Mewtwo ex" → "Mewtwo", "Latios ☆" →
    "Latios", "M Charizard-EX" → "Charizard". Trainers keep their full name;
    other games drop the Lorcana/Riftbound subtitle ("Elsa - Snow Queen")."""
    text = unicodedata.normalize("NFKC", str(name or "")).strip()
    text = _PARENS.sub("", text).strip()
    if not text:
        return ""
    if (game or GAME_POKEMON) != GAME_POKEMON:
        return re.split(r"\s+[-–—]\s+|,\s+", text)[0].strip()
    if supertype and not supertype.lower().startswith("pok"):
        return text
    stripped = _POSSESSIVE_PREFIX.sub("", text, count=1)
    if stripped:
        text = stripped
    # Separate glued markers like "Latios☆" or "Pikachu◇".
    text = re.sub(r"([☆★δ◇♢])", r" \1 ", text)
    changed = True
    while changed:
        changed = False
        text = _HYPHEN_SUFFIX.sub("", text).strip()
        tokens = text.split()
        if len(tokens) > 1 and tokens[-1].lower() in _SUFFIX_TOKENS:
            tokens.pop()
            changed = True
        if len(tokens) > 1 and tokens[0].lower() in _PREFIX_TOKENS:
            mega = tokens.pop(0).lower() in {"mega", "m"}
            if mega and len(tokens) > 1 and tokens[-1].lower() in {"x", "y"}:
                tokens.pop()  # "Mega Charizard X ex"
            changed = True
        text = " ".join(tokens)
    return text


def base_name_key(name: str | None, *, game: str | None = GAME_POKEMON, supertype: str | None = None) -> str:
    return base_name(name, game=game, supertype=supertype).casefold()


# --- payload -------------------------------------------------------------------


def _cards_by_id(connection: sqlite3.Connection, card_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not card_ids:
        return {}
    columns = _table_columns(connection, "cards")
    game_col = "game" if "game" in columns else "'pokemon'"
    placeholders = ",".join("?" for _ in card_ids)
    rows = connection.execute(
        f"SELECT id, name, set_name, number, language, image_small_url, image_url, set_id, supertype, {game_col} "
        f"FROM cards WHERE id IN ({placeholders})",
        card_ids,
    ).fetchall()
    return {
        str(r[0]): {
            "cardId": str(r[0]), "name": r[1], "setName": r[2], "number": r[3], "language": r[4],
            "imageUrl": r[5] or r[6], "setId": r[7], "supertype": r[8], "game": r[9] or GAME_POKEMON,
        }
        for r in rows
    }


def _similar_card(card: dict[str, Any], price: float | None) -> dict[str, Any]:
    return {
        "cardId": card["cardId"],
        "name": card["name"],
        "setName": card["setName"],
        "number": card["number"],
        "language": card["language"],
        "imageUrl": card["imageUrl"],
        "priceNow": round_money(price),
        "currencyCode": "USD",
    }


def empty_payload(card_id: str) -> dict[str, Any]:
    return {"cardId": card_id, "baseName": None, "goesWith": None, "sameName": [], "sameLookCheaper": []}


def build_similar_cards_payload(connection: sqlite3.Connection, card_id: str) -> dict[str, Any]:
    """The card page's "More like this" rows. Unknown card / no stored
    neighbours → the empty shape (every row empty), never an error."""
    if not _table_exists(connection, "card_similar"):
        return empty_payload(card_id)
    neighbour_rows = connection.execute(
        "SELECT neighbour_id, score FROM card_similar WHERE card_id = ? ORDER BY rank",
        (card_id,),
    ).fetchall()
    if not neighbour_rows:
        return empty_payload(card_id)
    neighbours = [(str(r[0]), float(r[1])) for r in neighbour_rows]
    cards = _cards_by_id(connection, [card_id, *(n for n, _ in neighbours)])
    card = cards.get(card_id)
    if card is None:
        return empty_payload(card_id)
    prices = {cid: p.price_now for cid, p in raw_price_changes(connection, list(cards)).items()}
    return split_neighbours(card, neighbours, cards, prices)


def split_neighbours(
    card: dict[str, Any],
    neighbours: list[tuple[str, float]],
    cards: dict[str, dict[str, Any]],
    prices: dict[str, float],
) -> dict[str, Any]:
    """Pure rule step: pair → same name → same look, lower price."""
    game = card.get("game") or GAME_POKEMON
    key = base_name_key(card["name"], game=game, supertype=card.get("supertype"))
    own_price = prices.get(card["cardId"])
    goes_with: dict[str, Any] | None = None
    same_name: list[dict[str, Any]] = []
    cheaper: list[dict[str, Any]] = []
    for neighbour_id, score in neighbours:  # best first
        other = cards.get(neighbour_id)
        if other is None:
            continue
        other_key = base_name_key(other["name"], game=other.get("game"), supertype=other.get("supertype"))
        if other_key and other_key == key:
            if len(same_name) < ROW_LIMIT:
                same_name.append(_similar_card(other, prices.get(neighbour_id)))
            continue
        if (
            goes_with is None
            and score >= GOES_WITH_MIN_SCORE
            and card.get("setId")
            and other.get("setId") == card.get("setId")
        ):
            goes_with = _similar_card(other, prices.get(neighbour_id))
            continue
        price = prices.get(neighbour_id)
        if own_price is not None and price is not None and price < own_price and len(cheaper) < ROW_LIMIT:
            cheaper.append(_similar_card(other, price))
    return {
        "cardId": card["cardId"],
        "baseName": base_name(card["name"], game=game, supertype=card.get("supertype")) or None,
        "goesWith": goes_with,
        "sameName": same_name,
        "sameLookCheaper": cheaper,
    }


def main() -> int:
    from catalog_tools import connect

    parser = argparse.ArgumentParser(description="Store art-embedding neighbours for the card page")
    parser.add_argument("--database-path", required=True, type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--chunk-rows", type=int, default=DEFAULT_CHUNK_ROWS)
    parser.add_argument("--game", action="append", help="limit to these games (repeatable)")
    args = parser.parse_args()
    paths = resolve_index_paths_by_game(args.repo_root)
    if args.game:
        paths = {g: p for g, p in paths.items() if g in set(args.game)}
    if not paths:
        print("[similar-cards] no active visual index found; nothing to do", file=sys.stderr)
        return 0
    # The live server shares this DB; wait out its write bursts rather than fail.
    connection = connect(args.database_path, timeout_seconds=60.0)
    try:
        summary = compute_similar_cards(
            connection, index_paths_by_game=paths, top_k=args.top_k, chunk_rows=args.chunk_rows
        )
    finally:
        connection.close()
    print(f"[similar-cards] {json.dumps(summary)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
