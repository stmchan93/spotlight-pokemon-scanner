#!/usr/bin/env python3
"""End-to-end comparison of the matcher with rerank ON vs OFF.

Calls the actual RawVisualMatcher (not a Python re-implementation) to
exercise the full integration path: encoder, adapter projection, index
search, language adjustment, variant merge, and (when on) the rerank
pool lookup. Toggles the rerank state in-place so the heavy CLIP load
only happens once.

Outputs:
- per-query results (top-1 id, finalScore, boost, rerank ms)
- aggregated top-1 hit rate on held-out vs covered surfaces
- per-query deltas (off → on)
- latency p50/p90/max
"""
from __future__ import annotations

import base64
import json
import os
import statistics
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Force rerank ON via env so __init__ wires the pool. We'll then toggle
# the state on the matcher instance to compare modes without rebuilding
# the (slow) encoder.
os.environ["SPOTLIGHT_VISUAL_USER_PHOTO_RERANK"] = "1"

from raw_visual_matcher import RawVisualMatcher  # noqa: E402


def encode_query_payload(image_path: Path) -> dict[str, Any]:
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return {
        "image": {"jpegBase64": b64},
        "scanID": image_path.parent.name,
        "clientContext": {"platform": "local-comparison"},
    }


def fixture_truth_pid(directory: Path, provider_truth_map: dict[str, str]) -> str | None:
    truth_path = directory / "truth.json"
    if not truth_path.exists():
        return None
    truth = json.loads(truth_path.read_text())
    name = str(truth.get("cardName") or "").strip()
    num = str(truth.get("collectorNumber") or "").strip()
    setc = str(truth.get("setCode") or "").strip()
    tk = f"{name}|{num}|{setc}"
    pid = provider_truth_map.get(tk)
    if pid:
        return pid
    if truth.get("providerCardId"):
        return str(truth["providerCardId"]).strip()
    label_status = directory / "label_status.json"
    if label_status.exists():
        ls_payload = json.loads(label_status.read_text())
        mapping = ls_payload.get("providerMapping") or {}
        if mapping.get("providerCardId"):
            return str(mapping["providerCardId"]).strip()
    return None


def main() -> None:
    print("Loading provider-truth mapping (qa/raw-footer-layout-check) ...")
    provider_truth_map: dict[str, str] = {}
    pm_path = REPO_ROOT / "qa" / "raw-footer-layout-check" / "provider_reference_manifest.json"
    if pm_path.exists():
        mf = json.loads(pm_path.read_text())
        for entry in mf.get("entries", []) or []:
            tk = str(entry.get("truthKey") or "")
            pid = str(entry.get("providerCardId") or "").strip()
            if tk and pid:
                provider_truth_map[tk] = pid

    held_out_roots = [
        REPO_ROOT / "qa" / "raw-footer-layout-check",
        Path("/Users/stephenchan/spotlight-datasets/raw-visual-expansion-holdouts/delta-raw-20260504-audit"),
    ]

    held_out_queries: list[tuple[str, str, Path]] = []
    for root in held_out_roots:
        if not root.exists():
            continue
        for tj in root.rglob("truth.json"):
            d = tj.parent
            qp = d / "runtime_normalized.jpg"
            if not qp.exists():
                continue
            pid = fixture_truth_pid(d, provider_truth_map)
            if pid:
                held_out_queries.append((d.name, pid, qp))
    print(f"  held-out mappable: {len(held_out_queries)}")

    rerank_pool_manifest = REPO_ROOT / "backend" / "data" / "visual-index" / "visual_index_user_photos_rerank_pool_v002_manifest.json"
    pool_meta = json.loads(rerank_pool_manifest.read_text())
    pool_entries = pool_meta.get("entries", [])
    covered_queries: list[tuple[str, str, Path]] = []
    seen_pids: set[str] = set()
    for entry in pool_entries:
        pid = entry["providerCardId"]
        if pid in seen_pids:
            continue
        seen_pids.add(pid)
        qp = Path(entry["normalizedImagePath"])
        if qp.exists():
            covered_queries.append((entry.get("fixtureName") or qp.parent.name, pid, qp))
        if len(covered_queries) >= 15:
            break
    print(f"  covered queries (one per pid, first 15): {len(covered_queries)}")

    print("\nConstructing matcher (rerank ON) — this loads CLIP once ...")
    matcher = RawVisualMatcher(repo_root=REPO_ROOT)

    print(f"  rerank_enabled={matcher.user_photo_rerank_enabled}")
    print(f"  rerank_alpha={matcher.user_photo_rerank_alpha}")
    print(f"  rerank_threshold={matcher.user_photo_rerank_threshold}")
    print(f"  pool_path={matcher.user_photo_rerank_npz_path.name}")

    # Warm up encoder
    print("\nWarming up encoder with one prewarm scan ...")
    matcher.prewarm(run_inference=True)
    pool_loaded = matcher._user_photo_rerank_pool is not None
    print(f"  pool loaded: {pool_loaded}")
    if pool_loaded:
        print(f"  pool unique cards: {matcher._user_photo_rerank_pool.unique_card_count}")
        print(f"  pool artifact version: {matcher._user_photo_rerank_pool.artifact_version}")

    def run_one(payload: dict[str, Any]) -> tuple[str | None, float, dict[str, Any], float]:
        t0 = time.perf_counter()
        matches, debug = matcher.match_payload(payload, top_k=10)
        t1 = time.perf_counter()
        top_pid = None
        top_score = 0.0
        if matches:
            entry = matches[0].entry
            top_pid = str(entry.get("providerCardId") or entry.get("id") or "") or None
            top_score = float(matches[0].similarity)
        rerank_dbg = debug.get("userPhotoRerank") or {}
        return top_pid, top_score, rerank_dbg, (t1 - t0) * 1000.0

    def evaluate(label: str, queries: list[tuple[str, str, Path]]) -> dict[str, Any]:
        # Run with rerank ON
        on_results = []
        for _, pid, qp in queries:
            payload = encode_query_payload(qp)
            top_pid, top_score, rerank_dbg, latency_ms = run_one(payload)
            on_results.append({
                "truth_pid": pid,
                "top_pid": top_pid,
                "top_score": top_score,
                "boosts_applied": rerank_dbg.get("boostsApplied", 0),
                "latency_ms": latency_ms,
            })

        # Toggle rerank OFF (state mutation; restore after)
        saved_enabled = matcher.user_photo_rerank_enabled
        saved_pool = matcher._user_photo_rerank_pool
        matcher.user_photo_rerank_enabled = False
        matcher._user_photo_rerank_pool = None
        try:
            off_results = []
            for _, pid, qp in queries:
                payload = encode_query_payload(qp)
                top_pid, top_score, _rr, latency_ms = run_one(payload)
                off_results.append({
                    "truth_pid": pid,
                    "top_pid": top_pid,
                    "top_score": top_score,
                    "latency_ms": latency_ms,
                })
        finally:
            matcher.user_photo_rerank_enabled = saved_enabled
            matcher._user_photo_rerank_pool = saved_pool

        on_top1 = sum(1 for r in on_results if r["top_pid"] == r["truth_pid"])
        off_top1 = sum(1 for r in off_results if r["top_pid"] == r["truth_pid"])
        total = len(queries)
        boosts_fired = sum(1 for r in on_results if r["boosts_applied"] > 0)

        on_lat = [r["latency_ms"] for r in on_results]
        off_lat = [r["latency_ms"] for r in off_results]

        # Per-query deltas
        improved = []
        regressed = []
        for q, on_r, off_r in zip(queries, on_results, off_results):
            if on_r["top_pid"] == on_r["truth_pid"] and off_r["top_pid"] != off_r["truth_pid"]:
                improved.append(q[0])
            elif on_r["top_pid"] != on_r["truth_pid"] and off_r["top_pid"] == off_r["truth_pid"]:
                regressed.append((q[0], off_r["top_pid"], on_r["top_pid"]))

        print(f"\n========== {label} ==========")
        print(f"  total queries:        {total}")
        print(f"  rerank-OFF top-1:     {off_top1}/{total} ({100*off_top1/total:.1f}%)")
        print(f"  rerank-ON  top-1:     {on_top1}/{total} ({100*on_top1/total:.1f}%)")
        print(f"  delta:                {on_top1 - off_top1:+d}  (improved={len(improved)}, regressed={len(regressed)})")
        print(f"  rerank fired (boosts>0): {boosts_fired}/{total}")
        if regressed:
            print(f"  REGRESSIONS:")
            for name, was, now in regressed[:10]:
                print(f"    {name}: was={was} now={now}")
        if improved:
            print(f"  IMPROVED ({len(improved)}):")
            for name in improved[:10]:
                print(f"    {name}")
        if on_lat:
            on_lat_sorted = sorted(on_lat)
            off_lat_sorted = sorted(off_lat)
            def pct(v, p): return v[int(len(v)*p) - 1] if v else 0
            print(f"  latency ms (rerank ON):  p50={statistics.median(on_lat):.1f}  p90={pct(on_lat_sorted, 0.9):.1f}  max={max(on_lat):.1f}")
            print(f"  latency ms (rerank OFF): p50={statistics.median(off_lat):.1f}  p90={pct(off_lat_sorted, 0.9):.1f}  max={max(off_lat):.1f}")
        return {
            "label": label,
            "total": total,
            "on_top1": on_top1,
            "off_top1": off_top1,
            "boosts_fired": boosts_fired,
        }

    held_out_summary = evaluate("HELD-OUT (uncovered cards — must not regress)", held_out_queries)
    covered_summary = evaluate("COVERED (cards with user photos — should improve)", covered_queries)

    # Edge case: the umbreon-059-131 fixture from raw-footer-layout-check
    # was the one that flipped at threshold=0.0 in our earlier sweep. With
    # threshold=0.90 it should remain a hit.
    print("\n========== EDGE CASE: umbreon-059-131 (was the threshold-0 regression) ==========")
    umbreon = REPO_ROOT / "qa" / "raw-footer-layout-check" / "umbreon-059-131"
    if umbreon.exists():
        pid = fixture_truth_pid(umbreon, provider_truth_map)
        qp = umbreon / "runtime_normalized.jpg"
        if qp.exists() and pid:
            payload = encode_query_payload(qp)
            top_pid, top_score, rerank_dbg, latency = run_one(payload)
            print(f"  truth pid:        {pid}")
            print(f"  top-1 (rerank ON): {top_pid}  score={top_score:.4f}  latency={latency:.1f}ms")
            print(f"  boosts applied:   {rerank_dbg.get('boostsApplied')}")
            print(f"  result:           {'✓ stayed correct' if top_pid == pid else '✗ regressed!'}")
            if rerank_dbg.get("boosts"):
                for b in rerank_dbg["boosts"][:5]:
                    print(f"    boost: {b['providerCardId']} userMax={b['userPhotoMaxSimilarity']:.4f} boost={b['boost']:+.4f}")
        else:
            print(f"  (skipped — qp.exists()={qp.exists()} pid={pid})")
    else:
        print("  (fixture not found)")

    print("\n========== FINAL ==========")
    print(f"  Held-out delta:  {held_out_summary['on_top1'] - held_out_summary['off_top1']:+d} top-1 fixtures")
    print(f"  Covered delta:   {covered_summary['on_top1'] - covered_summary['off_top1']:+d} top-1 fixtures")
    print(f"  Boost fire rate (covered): {covered_summary['boosts_fired']}/{covered_summary['total']}")
    print(f"  Boost fire rate (held-out): {held_out_summary['boosts_fired']}/{held_out_summary['total']}")


if __name__ == "__main__":
    main()
