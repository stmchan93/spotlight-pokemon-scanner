#!/usr/bin/env python3
"""Apples-to-apples hardware benchmark for the Spotlight backend.

Times the two CPU/disk-bound hot paths so you can compare a candidate box
(Hetzner CCX, DO droplet) against the current GCP t2d-standard-4 BEFORE moving:

  1. Visual encoder forward pass  — the SigLIP2/CLIP embed (raw_visual_model)
  2. Hot price-history read        — card_price_history_cell trend query (SQLite)

Run it INSIDE the container (has torch/onnxruntime) or the backend venv. Read-only:
it never writes to the DB, so the same command on both boxes is a valid comparison.

  # inside the running container:
  docker compose exec backend python tools/bench_hetzner.py --iters 100

  # or against the venv, pointing at the prod db:
  SPOTLIGHT_VISUAL_MODEL_ID=<your-siglip2-id> \
    .venv/bin/python tools/bench_hetzner.py --db data/spotlight_scanner.sqlite

Compare model_forward p50/p95 (the ~60ms encoder) and the cold price-query p50/p95
across boxes. The CPU header line tells you which chip each box is actually on.
"""
from __future__ import annotations

import argparse
import os
import platform
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

DEFAULT_DB = os.environ.get(
    "SPOTLIGHT_DATABASE_PATH", str(BACKEND_DIR / "data" / "spotlight_scanner.sqlite")
)


def _percentile(sorted_ms: list[float], q: float) -> float:
    if not sorted_ms:
        return float("nan")
    idx = min(len(sorted_ms) - 1, int(round(q * (len(sorted_ms) - 1))))
    return sorted_ms[idx]


def summarize(label: str, ms: list[float]) -> None:
    if not ms:
        print(f"  {label:<22} (no samples)")
        return
    s = sorted(ms)
    print(
        f"  {label:<22} p50={statistics.median(s):8.2f}ms  "
        f"p95={_percentile(s, 0.95):8.2f}ms  "
        f"min={s[0]:8.2f}ms  max={s[-1]:8.2f}ms  n={len(s)}"
    )


def print_system() -> None:
    print("== system ==")
    print(f"  python      {platform.python_version()}  (arch {platform.machine()})")
    cpu = platform.processor() or "?"
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except Exception:
        pass
    print(f"  cpu         {cpu}")
    print(f"  cores       {os.cpu_count()}")
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal"):
                print(f"  memory      {int(line.split()[1]) / 1024 / 1024:.1f} GiB")
                break
    except Exception:
        pass
    print()


def bench_encoder(iters: int, warmup: int) -> None:
    print("== encoder (visual forward pass) ==")
    try:
        from raw_visual_model import RawVisualFrozenEncoder
    except Exception as exc:  # torch/onnxruntime/transformers not importable
        print(f"  SKIPPED — could not import raw_visual_model ({exc})")
        print("  Run inside the container or backend venv so the ML deps are present.\n")
        return

    model_id = os.environ.get("SPOTLIGHT_VISUAL_MODEL_ID", "openai/clip-vit-base-patch32")
    print(f"  model_id    {model_id}")
    t0 = time.perf_counter()
    enc = RawVisualFrozenEncoder(model_id=model_id, device="auto", backend=None)
    print(f"  backend     {enc.backend}   (load {time.perf_counter() - t0:.1f}s)")

    # Content-independent synthetic image — timing depends on size, not pixels.
    rng = np.random.default_rng(0)
    img = Image.fromarray(rng.integers(0, 256, (512, 512, 3), dtype=np.uint8))

    for _ in range(warmup):
        enc.embed_images_with_timing([img], batch_size=1)

    forward, total = [], []
    for _ in range(iters):
        _, t = enc.embed_images_with_timing([img], batch_size=1)
        forward.append(float(t.get("modelForwardMs") or 0.0))
        total.append(float(t.get("totalMs") or 0.0))

    summarize("model_forward", forward)   # the pure CPU forward pass (~60ms on t2d-4)
    summarize("total_embed", total)       # + preprocess/postprocess (per-scan cost)
    print()


def bench_price(db_path: str, iters: int) -> None:
    print("== hot price query (card_price_history_cell) ==")
    if not Path(db_path).exists():
        print(f"  SKIPPED — db not found at {db_path}\n")
        return

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='card_price_history_cell'"
    )
    if not cur.fetchone():
        print("  SKIPPED — table card_price_history_cell not present\n")
        con.close()
        return

    cur.execute("SELECT card_id FROM card_price_history_cell LIMIT 5000")
    ids = [r[0] for r in cur.fetchall()]
    if not ids:
        print("  SKIPPED — no rows\n")
        con.close()
        return

    query = "SELECT * FROM card_price_history_cell WHERE card_id = ? ORDER BY price_date"
    cur.execute("EXPLAIN QUERY PLAN " + query, (ids[0],))
    plan = "; ".join(str(r[-1]) for r in cur.fetchall())
    print(f"  db          {db_path}")
    print(f"  plan        {plan}")

    rng = np.random.default_rng(1)
    picks = [ids[int(i)] for i in rng.integers(0, len(ids), size=iters)]

    # cold = first touch of a card_id; warm = immediate re-query (page-cache hit).
    cold, warm = [], []
    for cid in picks:
        t0 = time.perf_counter()
        cur.execute(query, (cid,)).fetchall()
        cold.append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        cur.execute(query, (cid,)).fetchall()
        warm.append((time.perf_counter() - t0) * 1000)
    con.close()

    summarize("cold (first touch)", cold)
    summarize("warm (cached)", warm)
    print("  NOTE: the OS page cache warms across runs. For a true cold-disk number,")
    print("        restart the container first (or, as root: sync; echo 3 > /proc/sys/vm/drop_caches).")
    print()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Spotlight backend hardware benchmark (encoder + hot price query)."
    )
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite DB path")
    ap.add_argument("--iters", type=int, default=50)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--skip-encoder", action="store_true")
    ap.add_argument("--skip-price", action="store_true")
    args = ap.parse_args()

    print_system()
    if not args.skip_encoder:
        bench_encoder(args.iters, args.warmup)
    if not args.skip_price:
        bench_price(args.db, args.iters)


if __name__ == "__main__":
    main()
