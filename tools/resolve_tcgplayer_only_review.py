#!/usr/bin/env python3
"""Resolve the TCGplayer-only classifier's REVIEW rows by picture.

Same picture as a card we have -> shadow_linked to it; different from every
candidate -> shadow_missing (new card); otherwise the row stays in review with
the reason. Logic: backend/tcgplayer_only_image_resolver.py.

    backend/.venv/bin/python tools/resolve_tcgplayer_only_review.py \
        --db backend/data/spotlight_scanner.sqlite --cache-dir /tmp/tpo-img \
        [--dry-run] [--review-html review.html] [--report-json out.json]

    # threshold calibration on the classifier's own shadow_linked rows
    ... --calibrate 200 --calibration-json calib.json

Candidate cards whose scanner visual-index row exists reuse that row (same
pipeline, no download); others are downloaded and embedded. Product and card
embeddings are cached in <cache-dir>/embeddings.npz keyed by image URL.
"""

from __future__ import annotations

import argparse
import html
import json
import random
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

import tcgplayer_only_catalog as tpo  # noqa: E402
import tcgplayer_only_image_resolver as res  # noqa: E402

INDEX_DIR = BACKEND_ROOT / "data" / "visual-index"
DEFAULT_ADAPTER = BACKEND_ROOT / "data" / "visual-models" / "raw_visual_adapter_active.pt"
MODEL_SLUG = "siglip2-base-patch16-384"


def default_index_pairs(index_dir: Path) -> list[tuple[Path, Path]]:
    pairs = [(index_dir / f"visual_index_active_{MODEL_SLUG}.npz", index_dir / "visual_index_active_manifest.json")]
    for game in ("onepiece", "gundam", "lorcana", "riftbound"):
        pairs.append((index_dir / f"visual_index_active_{game}_{MODEL_SLUG}.npz",
                      index_dir / f"visual_index_active_{game}_manifest.json"))
    return [(n, m) for n, m in pairs if n.exists() and m.exists()]


class LazyEmbedder:
    def __init__(self, adapter: Path, batch_size: int):
        self.adapter, self.batch_size, self._impl = adapter, batch_size, None

    def __call__(self, paths):
        if self._impl is None:
            self._impl = res.ScannerEmbedder(adapter_path=self.adapter, batch_size=self.batch_size)
        return self._impl(paths)


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--cache-dir", type=Path, required=True, help="Downloaded images + embeddings.npz")
    p.add_argument("--adapter", type=Path, default=DEFAULT_ADAPTER)
    p.add_argument("--index", action="append", default=None, metavar="NPZ:MANIFEST",
                   help="Scanner visual index to lift candidate rows from (repeatable). Default: the active ones in backend/data/visual-index.")
    p.add_argument("--no-index", action="store_true", help="Embed every candidate picture instead of using index rows.")
    p.add_argument("--placeholder-card-ids", type=Path, default=INDEX_DIR / "placeholder_card_ids.json")
    p.add_argument("--same-art", type=float, default=res.SAME_ART_THRESHOLD)
    p.add_argument("--different-art", type=float, default=res.DIFFERENT_ART_THRESHOLD)
    p.add_argument("--tie-margin", type=float, default=res.TIE_MARGIN)
    p.add_argument("--min-width", type=int, default=res.MIN_IMAGE_WIDTH)
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--product-id", action="append", default=None, help="Only these review rows.")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--report-json", type=Path, default=None, help="Every resolution (status, reason, top cosines).")
    p.add_argument("--review-html", type=Path, default=None, help="Visual page of the rows still in review.")
    p.add_argument("--calibrate", type=int, default=0, metavar="N",
                   help="Instead of resolving: sample N shadow_linked rows and report positive/negative cosines.")
    p.add_argument("--calibration-json", type=Path, default=None)
    p.add_argument("--seed", type=int, default=7)
    return p.parse_args(argv)


def _pairs(args) -> list[tuple[Path, Path]]:
    if args.no_index:
        return []
    if args.index:
        return [tuple(Path(x) for x in spec.split(":", 1)) for spec in args.index]
    return default_index_pairs(INDEX_DIR)


def _pct(values, q):
    return round(float(np.percentile(values, q)), 4) if len(values) else None


def _dist(values) -> dict:
    values = np.asarray(values, dtype=np.float32)
    if not len(values):
        return {"n": 0}
    return {"n": int(len(values)), "min": round(float(values.min()), 4), "p1": _pct(values, 1), "p5": _pct(values, 5),
            "p10": _pct(values, 10), "p25": _pct(values, 25), "median": _pct(values, 50), "p75": _pct(values, 75),
            "p90": _pct(values, 90), "p95": _pct(values, 95), "p99": _pct(values, 99), "max": round(float(values.max()), 4)}


def calibrate(args, connection, store, cache, embedder, index_vectors, placeholder_ids) -> dict:
    """Positives: a shadow_linked product vs its linked card. Negatives: the same
    product vs every other same-name card in its game (hardest one per product
    reported separately; identical-art reprints make that tail)."""
    rows = connection.execute(
        "SELECT product_id, category_id, game, card_id, evidence_json FROM tcgplayer_product_classifications "
        "WHERE status = ? AND card_id IS NOT NULL", (tpo.STATUS_SHADOW_LINKED,)).fetchall()
    rng = random.Random(args.seed)
    by_game = defaultdict(list)
    for row in rows:
        by_game[row[2]].append(row)
    # Stratified: an even share per game (small games give all they have).
    games = sorted(by_game)
    sample, remaining = [], args.calibrate
    for i, game in enumerate(sorted(games, key=lambda g: len(by_game[g]))):
        share = remaining // (len(games) - i)
        picked = rng.sample(by_game[game], min(share, len(by_game[game])))
        sample += picked
        remaining -= len(picked)
    index = tpo.load_catalog_index(connection)
    pairs = []  # (product_id, game, card_id, is_positive)
    for product_id, category_id, game_key, card_id, evidence_json in sample:
        game, language = res.TCGCSV_CATEGORY_GAME[category_id]
        evidence = json.loads(evidence_json)
        scope = index.scope(game, language)
        base, _ = tpo.split_product_name(evidence.get("name"))
        negatives = {c.id for k in tpo.product_name_keys(base) for c in scope.by_name.get(k, ())} - {card_id}
        pairs.append((product_id, game_key, card_id, True))
        pairs += [(product_id, game_key, cid, False) for cid in sorted(negatives)]
    card_ids = sorted({p[2] for p in pairs})
    meta = {}
    for start in range(0, len(card_ids), 900):
        chunk = card_ids[start:start + 900]
        for cid, url in connection.execute(f"SELECT id, image_url FROM cards WHERE id IN ({','.join('?' * len(chunk))})", chunk):
            meta[cid] = url or ""
    product_urls = {p[0]: res.TCGPLAYER_IMAGE_URL.format(pid=p[0]) for p in pairs}
    need_cards = {cid: meta.get(cid, "") for cid in card_ids if cid not in index_vectors and cid not in placeholder_ids and meta.get(cid)}
    store.fetch([*product_urls.values(), *need_cards.values()])
    shared = store.shared_counts(products=True)
    ok_products = {pid for pid, url in product_urls.items() if not store.guard(url, shared=shared, min_width=args.min_width)}
    shared = store.shared_counts(products=False)
    ok_cards = {cid for cid, url in need_cards.items() if not store.guard(url, shared=shared, min_width=1)}
    res.embed_urls([product_urls[p] for p in sorted(ok_products)] + [need_cards[c] for c in sorted(ok_cards)],
                   store=store, cache=cache, embedder=embedder, log=print)

    def card_vec(cid):
        if cid in placeholder_ids:
            return None
        if cid in index_vectors:
            return index_vectors[cid]
        return cache.rows.get(need_cards.get(cid, "")) if cid in ok_cards else None

    pos, neg, hardest = defaultdict(list), defaultdict(list), defaultdict(list)
    details = []
    hard_by_product = defaultdict(lambda: (-1.0, None))
    for product_id, game_key, cid, positive in pairs:
        if product_id not in ok_products:
            continue
        cv = card_vec(cid)
        if cv is None:
            continue
        sim = float(np.dot(cache.rows[product_urls[product_id]], cv))
        if positive:
            pos[game_key].append(sim)
            details.append({"productId": product_id, "game": game_key, "cardId": cid, "cosine": round(sim, 4), "positive": True})
        else:
            neg[game_key].append(sim)
            if sim > hard_by_product[product_id][0]:
                hard_by_product[product_id] = (sim, cid, game_key)
    for product_id, (sim, cid, *rest) in hard_by_product.items():
        if cid:
            hardest[rest[0]].append(sim)
            details.append({"productId": product_id, "game": rest[0], "cardId": cid, "cosine": round(sim, 4), "positive": False})
    allv = lambda d: [v for vs in d.values() for v in vs]  # noqa: E731
    report = {
        "sampledProducts": len(sample),
        "productsWithUsableImage": len(ok_products),
        "positives": {"all": _dist(allv(pos)), **{g: _dist(v) for g, v in sorted(pos.items())}},
        "negativesAllPairs": {"all": _dist(allv(neg)), **{g: _dist(v) for g, v in sorted(neg.items())}},
        "negativesHardestPerProduct": {"all": _dist(allv(hardest)), **{g: _dist(v) for g, v in sorted(hardest.items())}},
        "details": details,
    }
    for t in (0.80, 0.83, 0.85, 0.88, 0.90, 0.92, 0.93, 0.95, 0.97):
        report.setdefault("sweep", {})[str(t)] = {
            "positivesAtOrAbove": round(float(np.mean(np.asarray(allv(pos)) >= t)), 4) if allv(pos) else None,
            "negPairsAtOrAbove": round(float(np.mean(np.asarray(allv(neg)) >= t)), 5) if allv(neg) else None,
            "hardestNegAtOrAbove": round(float(np.mean(np.asarray(allv(hardest)) >= t)), 4) if allv(hardest) else None,
        }
    return report


def write_review_html(path: Path, connection: sqlite3.Connection, resolutions) -> int:
    still = [r for r in resolutions if r.status == tpo.STATUS_REVIEW]
    ids = sorted({c["cardId"] for r in still for c in (r.evidence.get("imageResolution", {}).get("top") or [])[:3]})
    images = {}
    for start in range(0, len(ids), 900):
        chunk = ids[start:start + 900]
        for cid, url, name, set_name, number in connection.execute(
                f"SELECT id, image_url, name, set_name, number FROM cards WHERE id IN ({','.join('?' * len(chunk))})", chunk):
            images[cid] = (url, f"{name} · {set_name} #{number}")
    by_reason = defaultdict(list)
    for r in still:
        by_reason[r.reason].append(r)
    esc = html.escape
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
        "<title>TCGplayer Review Rows</title><style>",
        ":root{--bg:#fff;--fg:#1b1b1f;--muted:#666;--card:#f4f4f6;--line:#ddd;--accent:#6b4fd8}",
        "@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141417;--fg:#ececf1;--muted:#9a9aa5;--card:#1f1f24;--line:#33333a;--accent:#a996ff}}",
        ":root[data-theme=dark]{--bg:#141417;--fg:#ececf1;--muted:#9a9aa5;--card:#1f1f24;--line:#33333a;--accent:#a996ff}",
        "body{background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,system-ui,sans-serif;margin:0;padding:16px;max-width:1200px;margin:auto}",
        "h2{margin:28px 0 8px;font-size:17px}.row{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;margin:10px 0;display:flex;gap:12px;flex-wrap:wrap}",
        ".pic{width:150px}.pic img{width:150px;border-radius:6px;display:block;background:var(--line);min-height:60px}.cap{font-size:12px;color:var(--muted);word-break:break-word}",
        ".meta{flex:1 1 220px;min-width:0}.cos{color:var(--accent);font-weight:600}code{font-size:12px}</style></head><body>",
        f"<h1>TCGplayer products still in review ({len(still)})</h1>",
        "<p class='cap'>Left: the TCGplayer product picture. Right: the closest cards we already have, with the picture similarity "
        "(same art ≈ 0.95+, different art ≲ 0.85). Fix a row by adding it to backend/tcgplayer_only_overrides.json.</p>",
    ]
    for reason, rows in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        parts.append(f"<h2>{esc(reason)} — {len(rows)}</h2>")
        for r in rows:
            info = r.evidence.get("imageResolution", {})
            ev = r.evidence
            parts.append("<div class='row'>")
            parts.append(f"<div class='pic'><img loading='lazy' src='{esc(info.get('productImageUrl', ''))}'>"
                         f"<div class='cap'>TCGplayer {esc(r.product_id)}</div></div>")
            parts.append(f"<div class='meta'><b>{esc(str(ev.get('name')))}</b><div class='cap'>{esc(str(ev.get('groupName')))} · "
                         f"#{esc(str(ev.get('number')))} · {esc(str(ev.get('rarity')))}</div>"
                         f"<div class='cap'>classifier: {esc(str(ev.get('reason')))} · candidates {info.get('candidateCount')}</div>"
                         f"<div class='cap'>max cosine <span class='cos'>{info.get('maxCosine')}</span></div></div>")
            for top in (info.get("top") or [])[:3]:
                url, caption = images.get(top["cardId"], ("", top["cardId"]))
                parts.append(f"<div class='pic'><img loading='lazy' src='{esc(url or '')}'><div class='cap'><span class='cos'>{top['cosine']:.3f}</span> "
                             f"{esc(caption)}<br><code>{esc(top['cardId'])}</code></div></div>")
            parts.append("</div>")
    parts.append("</body></html>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts), encoding="utf-8")
    return len(still)


def main(argv=None) -> int:
    args = parse_args(argv)
    t0 = time.time()
    connection = sqlite3.connect(args.db)
    store = res.ImageStore(args.cache_dir / "images", concurrency=args.concurrency)
    cache = res.EmbeddingCache(args.cache_dir / "embeddings.npz", res.model_tag(args.adapter))
    embedder = LazyEmbedder(args.adapter, args.batch_size)
    index_vectors = res.load_index_card_vectors(_pairs(args))
    placeholder_ids = res.load_placeholder_card_ids(args.placeholder_card_ids)
    print(f"[setup] {len(index_vectors)} index card rows, {len(cache.rows)} cached embeddings", flush=True)
    if args.calibrate:
        report = calibrate(args, connection, store, cache, embedder, index_vectors, placeholder_ids)
        summary = {k: v for k, v in report.items() if k != "details"}
        print(json.dumps(summary, indent=1))
        if args.calibration_json:
            args.calibration_json.write_text(json.dumps(report, indent=1))
        print(f"[done] {time.time() - t0:.1f}s")
        return 0
    thresholds = res.Thresholds(args.same_art, args.different_art, args.tie_margin)
    result = res.resolve_review(
        connection, store=store, cache=cache, embedder=embedder, index_vectors=index_vectors,
        placeholder_card_ids=placeholder_ids, thresholds=thresholds, product_ids=args.product_id,
        min_width=args.min_width, dry_run=args.dry_run, log=lambda m: print(m, flush=True),
    )
    if not args.dry_run:
        connection.commit()
    print(json.dumps({"counts": result.counts, "written": result.written, "timings": result.timings}, indent=1, ensure_ascii=False))
    totals = Counter()
    for counts in result.counts.values():
        for key, n in counts.items():
            totals["review" if key.startswith("review") else key] += n
    print(json.dumps(dict(totals)))
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps([
            {"productId": r.product_id, "status": r.status, "cardId": r.card_id, "proposedCardId": r.proposed_card_id,
             "reason": r.reason, "versionLabel": r.version_label, "name": r.evidence.get("name"),
             "groupName": r.evidence.get("groupName"), "classifierReason": r.evidence.get("reason"),
             "imageResolution": r.evidence.get("imageResolution")}
            for r in result.resolutions
        ], indent=1, ensure_ascii=False))
    if args.review_html:
        n = write_review_html(args.review_html, connection, result.resolutions)
        print(f"[html] {n} review rows -> {args.review_html}")
    print(f"[done] {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
