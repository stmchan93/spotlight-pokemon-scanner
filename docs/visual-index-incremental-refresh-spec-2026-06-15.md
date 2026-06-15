# Visual Index Incremental Refresh + Hot Reload — Spec (2026-06-15)

## Problem

New Scrydex cards sync to the catalog DB daily but are invisible to the camera matcher
until the **visual embedding index** (`data/visual-index/visual_index_active_*.npz` +
manifest) is rebuilt — which today only happens by hand on a dev machine. Chaos Rising
(Cinccino ex, etc.) was un-scannable for weeks despite being in the DB. The daily sync's
`refresh_embeddings` flag is a dead stub (`catalog_tools.py` deletes it).

## Goal

After each daily sync, **embed only the new cards** (seconds, not a 45-min full rebuild),
append them to the active index, and **hot-reload** the running matcher (no restart). Fully
automatic, self-contained on the VM. Proven safe: a full rebuild on 2026-06-15 showed
existing-card embeddings are byte-identical (cosine `1.000000`), so appends never disturb
existing rows.

## Architecture (reuse what exists)

- Encoder + adapter already run in the backend process on the VM (ONNX SigLIP2 + torch
  adapter): `backend/raw_visual_model.py` (`RawVisualFrozenEncoder.embed_images`,
  `project_embeddings_numpy`), wired in `backend/raw_visual_matcher.py`.
- Index format: `.npz` key `embeddings` `(N, 768)` float32, **row-aligned** with the
  manifest `entries[]` (`rowIndex` i ↔ row i). Loader validates `rows == len(entries)`:
  `backend/raw_visual_index.py` (`RawVisualIndex.load()`, lazy + cached under a lock).
- Reference-image download/cache helper: `tools/build_raw_visual_index.py`
  (`ensure_cached_reference_image`).
- New-card metadata comes from the **catalog DB `cards` table** (already synced: `id`,
  `name`, `set_name`, `number`, `language`, `set_id`, `set_release_date`, `image_url`) — no
  Scrydex re-fetch needed.

## Component 1 — Incremental append (`backend/append_visual_index_cards.py`, new)

Runs in the **backend venv** so it reuses the runtime encoder + adapter (no heavy build
venv). Pure additions in v1.

1. Load active paths from env (`SPOTLIGHT_VISUAL_INDEX_NPZ_PATH` / `_MANIFEST_PATH`); read
   manifest → `indexed_ids` set + current row count `N`; read the `.npz` embeddings.
2. Query `cards` for index-eligible rows (supertypes pokemon/trainer/energy, matching
   `DEFAULT_SUPERTYPES`). `missing = db_ids − indexed_ids`. Exit early if empty.
3. For each missing card: `ensure_cached_reference_image(card.image_url)` — **skip on
   download failure** (brand-new sets lag on Scrydex's CDN) and log the skip; it stays
   "missing" and retries next run.
4. Embed the cached images with the runtime encoder (same backend the matcher uses) and
   apply the **active adapter** (`project_embeddings_numpy`), then L2-normalize. Embed in
   batches (reuse `embed_images`, batch 64).
5. Build manifest entries (rowIndex `N…`) with the same fields the full build writes
   (providerCardId, name, collectorNumber, language, setId, setName, setReleaseDate,
   imageUrl, titleAliases, embeddingModel, artifactVersion).
6. `new_matrix = np.vstack([old, new])`; `entries += new_entries`; assert
   `rows == len(entries)`.
7. **Atomic swap:** write `*_active_*.npz.tmp` + `*_active_manifest.json.tmp`, rotate the
   current active to `.bak`, then `os.replace(tmp, active)` (atomic; the loader only ever
   sees a complete file). Update manifest `entryCount` + `lastIncrementalAppendAt`.
8. **Safety guard:** only swap if `new_count >= old_count`; abort + log if the skip rate is
   high (don't let a CDN outage shrink the index). Log appended count + skipped IDs.

## Component 2 — Hot reload (`raw_visual_matcher.py` + `server.py`)

- `RawVisualIndex.reload()` — under `_load_lock`, set `_matrix=None`/`_entries=None`, then
  `load()` (re-reads the same env paths). Trivial given the existing loader.
- `RawVisualMatcher.reload_index()` — call the index reload; thread-safe; return the new
  `entryCount`.
- `POST /api/v1/ops/reload-visual-index` — mirror the existing ops endpoints (same
  auth/guard as `/api/v1/ops/provider-status`); calls `reload_index()`, returns the new
  count. No restart, no downtime, no cold cache.

## Component 3 — Wire into the daily sync

- In `backend/run_sync_vm.sh`, after `sync_scrydex_catalog.py` **succeeds**: run
  `append_visual_index_cards.py` (backend venv), then `curl -XPOST
  localhost:8788/api/v1/ops/reload-visual-index`. `flock` to avoid overlap; log to
  `logs/visual_index_append.log`. The append no-ops when `missing` is empty, so it's safe
  to run every sync.

## Component 4 — Guardrail

Extend the health monitor to compare catalog `COUNT(*)` vs active index `entryCount`; log/
alert on drift > ~50. Now mostly a tripwire since the append keeps them in lockstep.

## Keep the full rebuild as an occasional safety net

`tools/build_raw_visual_index.py` stays for **on-demand** full rebuilds — when the
adapter/model changes, or to prune removed cards and re-embed cards whose art changed (v1
append is additions-only). Not scheduled.

## Risks / decisions

- **Encoder parity (ONNX append vs torch existing rows):** same SigLIP2 model → ~1.0 cosine
  (today's rebuild + the live runtime already mix torch index rows with ONNX query
  embeddings). Validate once: ONNX-embed a few already-indexed cards, compare to their
  rows; expect ≥0.999. If we want bit-exactness, run the append embed on the same backend
  the active index was built with.
- **Additions-only:** removed cards (rare, e.g. `lp_ja-28a`) and changed art aren't handled
  until a full rebuild. Acceptable; documented.
- **Row alignment:** never reorder existing rows; only append. `rowIndex` stays stable.
- **Atomicity/concurrency:** temp + `os.replace`; reload happens after the rename, so the
  matcher reads a complete file.

## Verification

- Unit: append on a tiny fixture index adds N rows, preserves existing rows (cosine 1.0),
  keeps `rows == len(entries)`; reload picks up the new count.
- On VM: add a card to the index via one append run → `POST reload` → `entryCount` rises;
  the new card resolves in a scan. Confirm a no-op run when nothing is missing.
- Guardrail: drift metric reads ~0 after a sync+append cycle.
