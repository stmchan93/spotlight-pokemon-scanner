"""Binder-page (9-card) scan POC: page photo -> 9 pockets -> matcher -> ids.

Two modes:

1. REAL PHOTO — the mode that matters once real captures exist:

       python3 tools/binder_scan_poc.py --page photo.jpg --game pokemon

   Pipeline: cv2 quad detection (largest 4-gon contour) -> perspective
   correction to a canonical page -> 3x3 subdivision with pocket insets ->
   each pocket resized to the matcher's 630x880 -> RawVisualMatcher per
   pocket. Falls back to naive thirds when no quad is found (photo taken
   square-on already).

2. SYNTHETIC — end-to-end validation with known truth, no camera needed:

       python3 tools/binder_scan_poc.py --synthesize qa/onepiece-real-photos \
           --game onepiece --pocket-px 360

   Composites real fixture photos (their runtime_normalized crops) into 3x3
   binder pages on a sleeve-gray background over a dark desk, applies a mild
   perspective warp + downscale so pockets land at ~--pocket-px (360 ~ what a
   FHD/4K phone frame gives a pocket), then runs the SAME pipeline and scores
   top-1/top-10 against each fixture's truth.json. This exercises quad
   detection, subdivision, and matching together — the whole POC loop.

Feasibility numbers behind this: docs/binder-scan-feasibility-2026-08-28.md.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

CARD_W, CARD_H = 630, 880
PAGE_COLS = PAGE_ROWS = 3
GAP, BORDER = 24, 48
PAGE_W = PAGE_COLS * CARD_W + (PAGE_COLS - 1) * GAP + 2 * BORDER
PAGE_H = PAGE_ROWS * CARD_H + (PAGE_ROWS - 1) * GAP + 2 * BORDER


def _matcher(game: str):
    os.environ.setdefault("SPOTLIGHT_VISUAL_MODEL_ID", "google/siglip2-base-patch16-384")
    if game == "pokemon":
        # Pin the npz+manifest PAIR: the matcher's defaults can resolve a stale
        # sibling manifest locally and fail the row-count check.
        idx = REPO / "backend/data/visual-index"
        os.environ.setdefault(
            "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH",
            str(idx / "visual_index_active_siglip2-base-patch16-384.npz"),
        )
        os.environ.setdefault(
            "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH",
            str(idx / "visual_index_active_manifest.json"),
        )
    if game != "pokemon":
        # Per-game indexes were built in the multi-game worktree; the main tree
        # may not carry them locally. Use whichever copy exists.
        roots = [
            REPO / "backend/data/visual-index",
            Path("/Users/stephenchan/Code/spotlight-onepiece/backend/data/visual-index"),
        ]
        npz_name = f"visual_index_active_{game}_siglip2-base-patch16-384.npz"
        root = next((r for r in roots if (r / npz_name).is_file()), None)
        if root is None:
            raise SystemExit(f"no visual index found for {game} in {[str(r) for r in roots]}")
        os.environ.setdefault(f"SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_{game.upper()}", str(root / npz_name))
        os.environ.setdefault(
            f"SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH_{game.upper()}",
            str(root / f"visual_index_active_{game}_manifest.json"),
        )
    from raw_visual_matcher import RawVisualMatcher

    return RawVisualMatcher(repo_root=REPO)


def detect_page_quad(bgr: np.ndarray) -> np.ndarray | None:
    """Largest plausible 4-gon in the frame, ordered tl,tr,br,bl. None = not found."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 40, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    frame_area = bgr.shape[0] * bgr.shape[1]
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
        area = cv2.contourArea(contour)
        if area < 0.25 * frame_area:
            break
        approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(approx) == 4:
            best = approx.reshape(4, 2).astype(np.float32)
            break
    if best is None:
        return None
    s = best.sum(axis=1)
    d = np.diff(best, axis=1).ravel()
    return np.array(
        [best[np.argmin(s)], best[np.argmin(d)], best[np.argmax(s)], best[np.argmax(d)]],
        dtype=np.float32,
    )


def split_page(bgr: np.ndarray) -> list[Image.Image]:
    """Quad-detect + rectify (fallback: whole frame), then 3x3 pockets at 630x880."""
    quad = detect_page_quad(bgr)
    if quad is not None:
        dst = np.array(
            [[0, 0], [PAGE_W, 0], [PAGE_W, PAGE_H], [0, PAGE_H]], dtype=np.float32
        )
        matrix = cv2.getPerspectiveTransform(quad, dst)
        page = cv2.warpPerspective(bgr, matrix, (PAGE_W, PAGE_H))
    else:
        page = cv2.resize(bgr, (PAGE_W, PAGE_H))
    pockets = []
    for r in range(PAGE_ROWS):
        for c in range(PAGE_COLS):
            x = BORDER + c * (CARD_W + GAP)
            y = BORDER + r * (CARD_H + GAP)
            cell = page[y : y + CARD_H, x : x + CARD_W]
            pockets.append(Image.fromarray(cv2.cvtColor(cell, cv2.COLOR_BGR2RGB)))
    return pockets


def match_pockets(matcher, pockets, game: str, top_k: int = 10):
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, pocket in enumerate(pockets):
            path = Path(tmp) / f"pocket-{i}.jpg"
            pocket.save(path, "JPEG", quality=90)
            started = time.perf_counter()
            matches, _debug = matcher.match_payload(
                {"game": game, "normalizedImagePath": str(path)}, top_k=top_k
            )
            results.append(
                {
                    "pocket": i,
                    "ms": round((time.perf_counter() - started) * 1000),
                    "top": [
                        {
                            "id": str(m.entry.get("providerCardId") or ""),
                            "number": str(m.entry.get("collectorNumber") or ""),
                            "name": str(m.entry.get("name") or ""),
                            "sim": round(float(m.similarity), 3),
                        }
                        for m in matches
                    ],
                }
            )
    return results


def synthesize_page(fixture_dirs, pocket_px: int, seed: int) -> tuple[np.ndarray, list]:
    """A binder page from 9 fixtures: sleeve-gray page on a dark desk, mild
    perspective warp, downscaled so a pocket is ~pocket_px wide."""
    rng = random.Random(seed)
    page = np.full((PAGE_H, PAGE_W, 3), 104, np.uint8)  # sleeve gray
    truths = []
    for idx, fdir in enumerate(fixture_dirs):
        img = cv2.imread(str(fdir / "runtime_normalized.jpg"))
        img = cv2.resize(img, (CARD_W, CARD_H))
        r, c = divmod(idx, PAGE_COLS)
        x = BORDER + c * (CARD_W + GAP)
        y = BORDER + r * (CARD_H + GAP)
        page[y : y + CARD_H, x : x + CARD_W] = img
        truths.append(json.loads((fdir / "truth.json").read_text()))
    # Desk canvas ~15% larger, dark
    desk_w, desk_h = int(PAGE_W * 1.3), int(PAGE_H * 1.3)
    desk = np.full((desk_h, desk_w, 3), 38, np.uint8)
    ox, oy = (desk_w - PAGE_W) // 2, (desk_h - PAGE_H) // 2
    src = np.array(
        [[ox, oy], [ox + PAGE_W, oy], [ox + PAGE_W, oy + PAGE_H], [ox, oy + PAGE_H]],
        dtype=np.float32,
    )
    jitter = 0.03 * PAGE_W
    dst = src + np.array(
        [[rng.uniform(-jitter, jitter), rng.uniform(-jitter, jitter)] for _ in range(4)],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(src, dst)
    desk_page = np.full((desk_h, desk_w, 3), 38, np.uint8)
    desk_page[oy : oy + PAGE_H, ox : ox + PAGE_W] = page
    warped = cv2.warpPerspective(desk_page, matrix, (desk_w, desk_h), borderValue=(38, 38, 38))
    # Camera resolution: pocket ~pocket_px wide -> frame width
    scale = (pocket_px * PAGE_COLS * 1.3) / desk_w * (PAGE_W / (PAGE_COLS * CARD_W))
    frame = cv2.resize(warped, (int(desk_w * scale), int(desk_h * scale)))
    return frame, truths


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--page", type=Path, help="Real binder-page photo to scan.")
    parser.add_argument("--synthesize", type=Path, help="Fixture root to build synthetic pages from.")
    parser.add_argument("--game", required=True)
    parser.add_argument("--pages", type=int, default=4)
    parser.add_argument("--pocket-px", type=int, default=360)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    matcher = _matcher(args.game)

    if args.page:
        bgr = cv2.imread(str(args.page))
        if bgr is None:
            raise SystemExit(f"cannot read {args.page}")
        quad = detect_page_quad(bgr)
        print(f"page: {args.page.name}  quad: {'FOUND' if quad is not None else 'fallback (thirds)'}")
        results = match_pockets(matcher, split_page(bgr), args.game)
        for row in results:
            top = row["top"][0] if row["top"] else {}
            print(
                f"  pocket {row['pocket']}: {top.get('number','—'):<12} "
                f"{top.get('name','')[:28]:<28} sim={top.get('sim')} ({row['ms']}ms)"
            )
        return 0

    fixtures = sorted(
        p for p in args.synthesize.iterdir() if (p / "truth.json").is_file()
    )
    rng = random.Random(args.seed)
    rng.shuffle(fixtures)
    total = {"pockets": 0, "top1": 0, "top10": 0, "quad": 0}
    for page_index in range(args.pages):
        chunk = fixtures[page_index * 9 : page_index * 9 + 9]
        if len(chunk) < 9:
            break
        frame, truths = synthesize_page(chunk, args.pocket_px, args.seed + page_index)
        quad_found = detect_page_quad(frame) is not None
        total["quad"] += int(quad_found)
        started = time.perf_counter()
        results = match_pockets(matcher, split_page(frame), args.game)
        wall = time.perf_counter() - started
        hits1 = hits10 = 0
        for row, truth in zip(results, truths):
            expected = str(truth["collectorNumber"]).strip().upper()
            got = [entry["number"].strip().upper() for entry in row["top"]]
            hits1 += int(bool(got) and got[0] == expected)
            hits10 += int(expected in got)
        total["pockets"] += 9
        total["top1"] += hits1
        total["top10"] += hits10
        print(
            f"page {page_index}: quad={'Y' if quad_found else 'N'} "
            f"top1 {hits1}/9  top10 {hits10}/9  wall {wall:.1f}s"
        )
    n = total["pockets"]
    print(
        f"\nTOTAL ({args.pages} pages, pocket≈{args.pocket_px}px): "
        f"quad {total['quad']}/{args.pages}  "
        f"top-1 {total['top1']}/{n} ({100*total['top1']/n:.1f}%)  "
        f"top-10 {total['top10']}/{n} ({100*total['top10']/n:.1f}%)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
