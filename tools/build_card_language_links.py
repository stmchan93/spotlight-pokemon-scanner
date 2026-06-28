#!/usr/bin/env python3
"""Build the card_language_links table (EN↔JP counterparts) used by the PDP
language toggle.

Pipeline (see docs/en-jp-card-language-link-plan-2026-06-27.md):
  1. PRUNE — for each card, candidate counterparts are the OTHER-language cards
     with the same English name + artist (and, when both sides have them, an
     overlapping national_pokedex_number and equal regulation_mark).
  2. MATCH — embed the ART CROP (ARTWORK_V1, excludes language-varying
     border/text) with the SigLIP2 encoder and pick the candidate with the
     highest cosine similarity.
  3. THRESHOLD — keep the best only if cosine >= --threshold; otherwise write no
     row (handles one-language exclusives and re-illustrated cards). The PDP
     hides the toggle when there is no row.

The metadata prune (`build_candidate_index`/`prune_candidates`) and the winner
selection (`select_counterpart`) are pure and unit-tested. The embedding step is
injectable via `embed_art_crops` so the core runs without the model; the default
embedder reuses backend/raw_visual_model.py + the artwork crop preset.

Run (Phase B, offline — needs the model + image access):
    python3 tools/build_card_language_links.py \
        --db backend/data/spotlight_scanner.sqlite \
        --threshold 0.92
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable


@dataclass(frozen=True)
class CardMeta:
    card_id: str
    language: str  # 'English' | 'Japanese'
    name_key: str  # normalized english name
    artist_key: str  # normalized artist
    pokedex: frozenset[int] = field(default_factory=frozenset)
    regulation_mark: str | None = None


def _norm(value: str | None) -> str:
    return (value or "").strip().lower()


def card_meta_from_row(row: sqlite3.Row) -> CardMeta:
    try:
        dex = json.loads(row["national_pokedex_numbers_json"] or "[]")
    except (json.JSONDecodeError, TypeError):
        dex = []
    return CardMeta(
        card_id=str(row["id"]),
        language=str(row["language"] or ""),
        name_key=_norm(row["name"]),
        artist_key=_norm(row["artist"]),
        pokedex=frozenset(int(n) for n in dex if isinstance(n, (int, float))),
        regulation_mark=(_norm(row["regulation_mark"]) or None),
    )


def build_candidate_index(cards: Iterable[CardMeta]) -> dict[tuple[str, str], list[CardMeta]]:
    """Index cards by (name_key, artist_key) for O(1) cross-language pruning."""
    index: dict[tuple[str, str], list[CardMeta]] = {}
    for card in cards:
        if not card.name_key or not card.artist_key:
            continue
        index.setdefault((card.name_key, card.artist_key), []).append(card)
    return index


def prune_candidates(
    card: CardMeta,
    index: dict[tuple[str, str], list[CardMeta]],
) -> list[CardMeta]:
    """Other-language cards sharing name+artist, further constrained by pokedex
    overlap and regulation_mark equality WHEN both sides carry those signals."""
    if not card.name_key or not card.artist_key:
        return []
    out: list[CardMeta] = []
    for other in index.get((card.name_key, card.artist_key), ()):  # same name+artist
        if other.language == card.language or other.card_id == card.card_id:
            continue
        if card.pokedex and other.pokedex and not (card.pokedex & other.pokedex):
            continue
        if card.regulation_mark and other.regulation_mark and card.regulation_mark != other.regulation_mark:
            continue
        out.append(other)
    return out


def select_counterpart(
    candidate_ids: list[str],
    scores: dict[str, float],
    *,
    threshold: float,
) -> tuple[str | None, float | None]:
    """Pick the highest-scoring candidate at/above the threshold, else (None, None).

    Tiebreak on equal score: lowest card_id (stable, deterministic)."""
    best_id: str | None = None
    best_score = -1.0
    for cid in candidate_ids:
        score = scores.get(cid)
        if score is None:
            continue
        if score > best_score or (score == best_score and (best_id is None or cid < best_id)):
            best_id, best_score = cid, score
    if best_id is None or best_score < threshold:
        return None, None
    return best_id, best_score


import re


def _norm_num(value: str | None) -> str:
    s = (value or "").split("/")[0].strip().lower()
    return str(int(s)) if s.isdigit() else re.sub(r"\s+", "", s)


def detect_set_pairs(conn: sqlite3.Connection, *, min_overlap: int = 15) -> dict[str, str]:
    """Confirmed EN→JP set correspondences: two sets pair when >= min_overlap
    cards share the same normalized collector number AND English name. Returns
    {en_set_id: jp_set_id} (best 1:1 per EN set). Independent of artwork."""
    conn.row_factory = sqlite3.Row
    from collections import defaultdict

    en: dict[str, dict[str, str]] = defaultdict(dict)
    jp: dict[str, dict[str, str]] = defaultdict(dict)
    for r in conn.execute("SELECT set_id, language, name, number FROM cards"):
        if not r["set_id"]:
            continue
        bucket = en if r["language"] == "English" else jp if r["language"] == "Japanese" else None
        if bucket is None:
            continue
        bucket[r["set_id"]].setdefault(_norm_num(r["number"]), str(r["name"] or "").strip().lower())

    key_jp: dict[tuple[str, str], list[str]] = defaultdict(list)
    for sid, m in jp.items():
        for num, name in m.items():
            key_jp[(num, name)].append(sid)
    counts: dict[tuple[str, str], int] = defaultdict(int)
    for sid, m in en.items():
        for num, name in m.items():
            for jsid in key_jp.get((num, name), ()):
                counts[(sid, jsid)] += 1

    best: dict[str, tuple[str, int]] = {}
    for (esid, jsid), cnt in counts.items():
        if cnt >= min_overlap and (esid not in best or cnt > best[esid][1]):
            best[esid] = (jsid, cnt)
    return {esid: jsid for esid, (jsid, _) in best.items()}


def deterministic_links(
    conn: sqlite3.Connection, set_pairs: dict[str, str]
) -> dict[str, tuple[str, str, str]]:
    """Bidirectional links by collector number within confirmed set pairs.
    Returns {card_id: (counterpart_card_id, counterpart_language, 'set_number')}."""
    conn.row_factory = sqlite3.Row
    from collections import defaultdict

    by_set: dict[str, dict[str, tuple[str, str]]] = defaultdict(dict)  # set_id -> num -> (name, card_id)
    wanted = set(set_pairs) | set(set_pairs.values())
    for r in conn.execute("SELECT id, set_id, name, number FROM cards"):
        if r["set_id"] in wanted:
            by_set[r["set_id"]].setdefault(_norm_num(r["number"]), (str(r["name"] or "").strip().lower(), r["id"]))

    out: dict[str, tuple[str, str, str]] = {}
    for en_set, jp_set in set_pairs.items():
        em, jm = by_set.get(en_set, {}), by_set.get(jp_set, {})
        for num, (name, en_card) in em.items():
            jp_entry = jm.get(num)
            if jp_entry and jp_entry[0] == name:
                jp_card = jp_entry[1]
                out.setdefault(en_card, (jp_card, "Japanese", "set_number"))
                out.setdefault(jp_card, (en_card, "English", "set_number"))
    return out


EmbedArtCrops = Callable[[list[str]], dict[str, "list[float]"]]


def _cosine(a, b) -> float:
    import numpy as np

    va, vb = np.asarray(a, dtype="float32"), np.asarray(b, dtype="float32")
    na, nb = np.linalg.norm(va), np.linalg.norm(vb)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(va, vb) / (na * nb))


def build_links(
    conn: sqlite3.Connection,
    *,
    embed_art_crops: EmbedArtCrops,
    threshold: float,
    match_method: str = "art_embedding",
    now: str | None = None,
    name_filter: set[str] | None = None,
    replace_table: bool = True,
    use_set_pairs: bool = True,
    min_overlap: int = 15,
) -> int:
    """Compute counterpart links and write the card_language_links table.

    Hybrid: PRIMARY deterministic links by collector number within confirmed
    EN↔JP set pairs (correct by construction), then the art embedding as a
    FALLBACK for every card a set pair doesn't already cover.

    Returns the number of directed link rows written. `name_filter` (lowercased
    names) restricts the card universe for a pilot run; `replace_table=False`
    upserts without clearing."""
    conn.row_factory = sqlite3.Row
    stamp = now or datetime.now(timezone.utc).isoformat()

    # PRIMARY: deterministic set-pair + number links.
    det: dict[str, tuple[str, str, str]] = (
        deterministic_links(conn, detect_set_pairs(conn, min_overlap=min_overlap))
        if use_set_pairs else {}
    )

    cards = [card_meta_from_row(r) for r in conn.execute(
        "SELECT id, language, name, artist, national_pokedex_numbers_json, regulation_mark FROM cards"
    )]
    if name_filter is not None:
        names_in = name_filter
        cards = [c for c in cards if c.name_key in names_in]
        det = {cid: v for cid, v in det.items() if any(c.card_id == cid for c in cards)}
    index = build_candidate_index(cards)

    # FALLBACK embedding: only cards a deterministic link doesn't already cover
    # AND that have a pruned candidate.
    candidates_by_card: dict[str, list[CardMeta]] = {}
    need_embed: set[str] = set()
    for card in cards:
        if card.card_id in det:
            continue
        pruned = prune_candidates(card, index)
        if pruned:
            candidates_by_card[card.card_id] = pruned
            need_embed.add(card.card_id)
            need_embed.update(c.card_id for c in pruned)

    vecs = embed_art_crops(sorted(need_embed)) if need_embed else {}

    rows: list[tuple] = [
        (cid, cp, lang, None, method, stamp) for cid, (cp, lang, method) in det.items()
    ]
    for card_id, pruned in candidates_by_card.items():
        query_vec = vecs.get(card_id)
        if query_vec is None:
            continue
        scores = {
            c.card_id: _cosine(query_vec, vecs[c.card_id])
            for c in pruned
            if c.card_id in vecs
        }
        best_id, best_score = select_counterpart([c.card_id for c in pruned], scores, threshold=threshold)
        if best_id is None:
            continue
        counterpart_language = next(c.language for c in pruned if c.card_id == best_id)
        rows.append((card_id, best_id, counterpart_language, best_score, match_method, stamp))

    if replace_table:
        conn.execute("DELETE FROM card_language_links")
    conn.executemany(
        """
        INSERT OR REPLACE INTO card_language_links
            (card_id, counterpart_card_id, counterpart_language, match_score, match_method, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def _default_embedder(
    conn: sqlite3.Connection,
    *,
    model_id: str,
    device: str,
    cache_dir: Path,
    batch_size: int,
) -> EmbedArtCrops:
    """Reuses the SigLIP2 encoder + ARTWORK_V1 crop to embed each card's art window."""

    def embed(card_ids: list[str]) -> dict[str, list[float]]:
        import io
        import urllib.request

        import numpy as np
        from PIL import Image

        # Heavy imports kept local so the module loads cheaply for unit tests.
        import sys

        # backend/ for raw_visual_model, tools/ (this file's dir) for
        # build_raw_visual_index — works regardless of how the script is invoked.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from raw_visual_model import RawVisualFrozenEncoder  # type: ignore
        from build_raw_visual_index import ARTWORK_V1_CROP_BOX, apply_crop_preset  # type: ignore  # noqa: F401

        cache_dir.mkdir(parents=True, exist_ok=True)
        # backend="onnx" matches the deployed runtime (SigLIP2 FP32 ONNX).
        encoder = RawVisualFrozenEncoder(model_id=model_id, device=device, backend="onnx")
        conn.row_factory = sqlite3.Row
        url_by_id = {
            str(r["id"]): (r["image_url"] or r["image_small_url"])
            for r in conn.execute(
                "SELECT id, image_url, image_small_url FROM cards WHERE id IN (%s)"
                % ",".join("?" * len(card_ids)),
                card_ids,
            )
        }

        def find_cached(card_id: str) -> "Path | None":
            # The reference-image cache (shared with build_raw_visual_index) stores
            # whatever extension the source served — usually .png. Reuse any of them
            # so a populated cache means zero downloads.
            for ext in ("png", "jpg", "jpeg", "webp"):
                p = cache_dir / f"{card_id}.{ext}"
                if p.exists():
                    return p
            return None

        def load_art(card_id: str) -> "Image.Image | None":
            cached = find_cached(card_id)
            if cached is None:
                url = url_by_id.get(card_id)
                if not url:
                    return None
                cached = cache_dir / f"{card_id}.jpg"
                try:
                    with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310
                        cached.write_bytes(resp.read())
                except Exception:  # noqa: BLE001 - skip unfetchable images
                    return None
            try:
                img = Image.open(io.BytesIO(cached.read_bytes())).convert("RGB")
            except Exception:  # noqa: BLE001
                return None
            box = ARTWORK_V1_CROP_BOX
            w, h = img.size
            return img.crop((int(box[0] * w), int(box[1] * h), int((box[0] + box[2]) * w), int((box[1] + box[3]) * h)))

        out: dict[str, list[float]] = {}
        batch_ids: list[str] = []
        batch_imgs: list[Image.Image] = []

        def flush() -> None:
            if not batch_imgs:
                return
            mat = encoder.embed_images(batch_imgs, batch_size=batch_size)
            for cid, vec in zip(batch_ids, np.asarray(mat)):
                out[cid] = vec.astype("float32").tolist()
            batch_ids.clear()
            batch_imgs.clear()

        for cid in card_ids:
            art = load_art(cid)
            if art is None:
                continue
            batch_ids.append(cid)
            batch_imgs.append(art)
            if len(batch_imgs) >= batch_size:
                flush()
        flush()
        return out

    return embed


def add_unique_name_artist_links(
    conn: sqlite3.Connection,
    *,
    embed_art_crops: EmbedArtCrops,
    unique_floor: float = 0.6,
    denylist: frozenset[str] = frozenset(),
    now: str | None = None,
) -> int:
    """Overlay: link cards that have EXACTLY ONE same-name+artist cross-language
    candidate (so the counterpart is unambiguous) even when art similarity is
    below the normal floor — this recovers full-art / alt-art chase cards
    (e.g. Moonbreon) whose EN/JP layouts differ. A low `unique_floor` cosine gate
    still rejects genuinely-unrelated pairs. Skips any denylisted card_id /
    "card_id,counterpart_id". Only adds cards not already linked. Returns count."""
    conn.row_factory = sqlite3.Row
    stamp = now or datetime.now(timezone.utc).isoformat()
    cards = [card_meta_from_row(r) for r in conn.execute(
        "SELECT id, language, name, artist, national_pokedex_numbers_json, regulation_mark FROM cards"
    )]
    index = build_candidate_index(cards)
    existing = {r[0] for r in conn.execute("SELECT card_id FROM card_language_links")}

    pairs: list[tuple[str, str, str]] = []
    need: set[str] = set()
    for card in cards:
        if card.card_id in existing:
            continue
        cand = prune_candidates(card, index)
        if len(cand) == 1:
            pairs.append((card.card_id, cand[0].card_id, cand[0].language))
            need.add(card.card_id)
            need.add(cand[0].card_id)

    vecs = embed_art_crops(sorted(need)) if need else {}
    rows = []
    for cid, cp, lang in pairs:
        if cid in denylist or f"{cid},{cp}" in denylist:
            continue
        if cid not in vecs or cp not in vecs:
            continue
        score = _cosine(vecs[cid], vecs[cp])
        if score < unique_floor:
            continue
        rows.append((cid, cp, lang, score, "name_artist_unique", stamp))
    conn.executemany(
        """
        INSERT OR REPLACE INTO card_language_links
            (card_id, counterpart_card_id, counterpart_language, match_score, match_method, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def load_denylist(path: str | None) -> frozenset[str]:
    if not path or not Path(path).exists():
        return frozenset()
    out = set()
    for line in Path(path).read_text().splitlines():
        s = line.split("#", 1)[0].strip()
        if s:
            out.add(s)
    return frozenset(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--threshold", type=float, default=0.92, help="Min cosine to accept a link")
    parser.add_argument("--model-id", default="google/siglip2-base-patch16-384")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--cache-dir", default="backend/data/visual-index/.cache/reference_images")
    parser.add_argument("--names", default="", help="Comma-separated card names to restrict a pilot run")
    parser.add_argument("--unique-overlay", action="store_true",
                        help="Only overlay unique-name+artist links onto the existing table (no full rebuild)")
    parser.add_argument("--unique-floor", type=float, default=0.6)
    parser.add_argument("--denylist", default="tools/card_language_link_denylist.txt")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    embedder = _default_embedder(
        conn,
        model_id=args.model_id,
        device=args.device,
        cache_dir=Path(args.cache_dir),
        batch_size=args.batch_size,
    )
    if args.unique_overlay:
        added = add_unique_name_artist_links(
            conn, embed_art_crops=embedder, unique_floor=args.unique_floor,
            denylist=load_denylist(args.denylist),
        )
        conn.close()
        print(f"name_artist_unique links added: {added}")
        return

    name_filter = (
        {n.strip().lower() for n in args.names.split(",") if n.strip()} if args.names else None
    )
    written = build_links(
        conn,
        embed_art_crops=embedder,
        threshold=args.threshold,
        name_filter=name_filter,
        replace_table=name_filter is None,  # a pilot upserts; a full run replaces
    )
    conn.close()
    print(f"card_language_links rows written: {written}")


if __name__ == "__main__":
    main()
