#!/usr/bin/env python3
"""Compose side-by-side EN|JP montages of card_language_links for visual precision
auditing. Renders a stratified random sample as labeled grid images that a human
(or a vision model) can judge "same artwork? y/n" en masse, plus a manifest.

Usage:
    python3 tools/build_link_audit_montage.py --db <db> --out-dir <dir> \
        --n 40 --min-score 0.88 --max-score 0.90 --method art_embedding --tag marginal
"""
from __future__ import annotations

import argparse
import glob
import random
import sqlite3
from pathlib import Path

from PIL import Image, ImageDraw

CACHE = "backend/data/visual-index/.cache/reference_images"
THUMB_W = 150
COLS = 5
PER_MONTAGE = 25

# Index the cache dir ONCE (44k files) — globbing per card is O(dir) per call.
_CACHE_INDEX: dict[str, str] = {}


def _build_cache_index() -> None:
    import os

    for fn in os.listdir(CACHE):
        stem = fn.rsplit(".", 1)[0]
        _CACHE_INDEX.setdefault(stem, f"{CACHE}/{fn}")


def _cached(cid: str) -> str | None:
    return _CACHE_INDEX.get(cid)


def _thumb(path: str | None) -> Image.Image:
    h = int(THUMB_W / 0.72)
    if not path:
        return Image.new("RGB", (THUMB_W, h), (40, 40, 40))
    try:
        im = Image.open(path).convert("RGB")
        return im.resize((THUMB_W, h))
    except Exception:  # noqa: BLE001
        return Image.new("RGB", (THUMB_W, h), (80, 0, 0))


def run(db_path: Path, out_dir: Path, *, n: int, min_score: float, max_score: float,
        method: str, tag: str, seed: int) -> None:
    _build_cache_index()
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    where = ["e.language='English'", "l.match_score>=?", "l.match_score<?"]
    params: list = [min_score, max_score]
    if method != "any":
        where.append("l.match_method=?")
        params.append(method)
    rows = con.execute(
        f"""select e.id en, e.name en_name, e.set_name es, l.counterpart_card_id jp,
                   j.set_name js, round(l.match_score,3) s
            from card_language_links l
            join cards e on e.id=l.card_id join cards j on j.id=l.counterpart_card_id
            where {' AND '.join(where)}""",
        params,
    ).fetchall()
    con.close()

    rows = [r for r in rows if _cached(r["en"]) and _cached(r["jp"])]
    rng = random.Random(seed)
    sample = rows if len(rows) <= n else rng.sample(rows, n)

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = out_dir / f"manifest_{tag}.txt"
    cell_w = THUMB_W * 2 + 14
    cell_h = int(THUMB_W / 0.72) + 22
    lines = [f"# {tag}: {len(sample)} pairs sampled (band [{min_score},{max_score}) method={method}) of {len(rows)} eligible"]
    montage_paths = []
    for mi in range(0, len(sample), PER_MONTAGE):
        chunk = sample[mi:mi + PER_MONTAGE]
        rows_n = (len(chunk) + COLS - 1) // COLS
        canvas = Image.new("RGB", (cell_w * COLS, cell_h * rows_n), (255, 255, 255))
        draw = ImageDraw.Draw(canvas)
        for ci, r in enumerate(chunk):
            idx = mi + ci + 1
            x = (ci % COLS) * cell_w
            y = (ci // COLS) * cell_h
            draw.text((x + 2, y + 1), f"#{idx}  {r['s']}", fill=(0, 0, 0))
            canvas.paste(_thumb(_cached(r["en"])), (x, y + 14))
            canvas.paste(_thumb(_cached(r["jp"])), (x + THUMB_W + 8, y + 14))
            lines.append(f"#{idx}\t{r['s']}\t{r['en_name']}\tEN {r['en']} [{r['es']}]\tJP {r['jp']} [{r['js']}]")
        p = out_dir / f"montage_{tag}_{mi // PER_MONTAGE + 1}.png"
        canvas.save(p)
        montage_paths.append(str(p))
    manifest.write_text("\n".join(lines) + "\n")
    print(f"montages: {montage_paths}")
    print(f"manifest: {manifest}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--max-score", type=float, default=1.01)
    ap.add_argument("--method", default="art_embedding")
    ap.add_argument("--tag", default="audit")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    run(Path(args.db), Path(args.out_dir), n=args.n, min_score=args.min_score,
        max_score=args.max_score, method=args.method, tag=args.tag, seed=args.seed)


if __name__ == "__main__":
    main()
