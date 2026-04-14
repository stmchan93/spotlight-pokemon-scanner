# Repo Asset Storage Migration Spec

## Goal

Stop treating the Git repo as the storage location for large card-photo datasets,
generated OCR artifacts, and training/reference image caches.

Keep the repo for:

- app/backend code
- small manifests and truth metadata
- lightweight docs and scripts

Move large assets out of the repo to:

- local external dataset roots for development
- object storage for shared team datasets
- provider APIs + SQLite for runtime card metadata and pricing

## Current Findings

### Git-tracked asset footprint

Current tracked working-tree size is dominated by `qa/`:

- `qa/`: about `70 MB` tracked right now
- `qa/raw-footer-layout-check`: about `47 MB` tracked
- `qa/slab-regression`: about `9.6 MB` tracked
- `qa/incoming-slab-regression`: about `7.1 MB` tracked
- `qa/ocr-golden`: about `4.7 MB` tracked
- `qa/incoming-ocr-fixtures`: about `2.0 MB` tracked

### Git history footprint

`git count-objects -vH` shows the real long-term problem:

- `size-pack: 1.86 GiB`

That means historical binary asset commits are already bloating clone/fetch size
well beyond the current working-tree size.

### Local non-Git data footprint

Most of the local disk usage is not actually Git-tracked:

- `backend/data`: about `37 GB`
  - SQLite runtime DB
  - visual indexes
  - visual model artifacts
- `qa/raw-visual-train`: about `70 MB`
- `qa/raw-visual-train-excluded`: about `31 MB`

These are local workspace/storage problems, not GitHub history problems.

## Runtime Dependency Audit

### Runtime data that is already off-repo in practice

The runtime backend already prefers live providers plus local SQLite:

- card metadata cache:
  - `cards` table in SQLite
  - see `backend/catalog_tools.py`
- pricing cache:
  - `card_price_snapshots` table in SQLite
  - freshness is based on persisted timestamps
- repeat-scan slab cache:
  - `scan_events` table in SQLite
- raw visual index/model artifacts:
  - `backend/data/visual-index/`
  - `backend/data/visual-models/`
  - already ignored by `.gitignore`

This means the production/runtime architecture does **not** need checked-in card
image bundles.

### Runtime paths that still depend on local image caches

There is still one important local-image dependency in the raw path:

- `backend/raw_set_badge_matcher.py`
  - reads `referenceImagePath`
  - opens local reference images for badge scoring

Those reference image paths are not read from `qa/` directly at runtime, but
they do require a local cache outside provider APIs. That cache should move to a
stable external dataset root instead of living under repo QA folders.

### QA/test paths that currently depend on repo-local datasets

These are the main tracked dataset consumers:

- `SpotlightTests/OCRRewriteStage1FixtureTests.swift`
  - reads `qa/raw-footer-layout-check`
  - already supports:
    - `qa/.raw_layout_fixture_root_override.txt`
    - `SPOTLIGHT_RAW_LAYOUT_FIXTURE_ROOT`
- `SpotlightTests/OCRFixtureExecutionTests.swift`
  - slab regression still reads `qa/slab-regression` directly
  - should get the same override support
- visual tooling already supports custom paths:
  - `tools/build_raw_visual_training_manifest.py`
  - `tools/run_raw_visual_poc.py`
  - custom fixture/cache roots are already arguments

## What Should Leave The Repo

### Category A: Generated artifacts

These should not be tracked in Git at all:

- `qa/ocr-golden/**`
- `qa/slab-regression/simulator-vision-v1/**`
- generated raw regression outputs inside `qa/raw-footer-layout-check/**`
  - `runtime_normalized.jpg`
  - `runtime_selection_summary.json`
  - `raw_ocr_regression_result.json`
  - overlays / selection manifests / scorecards

Rule:

- generated artifacts should be written to a local output root
- manifests and source truth remain separate

### Category B: Source QA fixture images

These are legitimate datasets, but they should live outside the code repo:

- `qa/raw-footer-layout-check/**/source_scan.jpg`
- `qa/incoming-ocr-fixtures/*.jpg`
- `qa/incoming-slab-regression/*.jpg`
- future held-out slab label-only photos

Rule:

- keep only compact manifests / truth metadata in the repo
- move the actual images to an external dataset root or object storage

### Category C: Downloaded reference image caches

These are cache artifacts, not source-of-truth assets:

- `qa/raw-footer-layout-check/.visual_reference_cache/**`
- `qa/raw-visual-train/.visual_reference_cache/**`
- any future provider reference image downloads

Rule:

- cache outside the repo
- regenerate or redownload as needed

### Category D: Local training datasets

These are already not tracked, but they still should not live inside the repo
tree:

- `qa/raw-visual-train`
- `qa/raw-visual-train-excluded`

Rule:

- move them to a sibling or centralized dataset workspace

## Recommended Target Architecture

### 1. Keep runtime metadata/pricing provider-driven

Do not create a new checked-in local card catalog.

Continue using:

- raw metadata/pricing: Pokemon TCG API + SQLite cache
- slab identity/pricing: Scrydex + SQLite cache

### 2. Move all large QA/training assets to an external dataset root

Recommended local layout:

```text
~/spotlight-datasets/
  raw-footer-layout-check/
  raw-visual-train/
  raw-visual-train-excluded/
  slab-regression/
  incoming-ocr-fixtures/
  incoming-slab-regression/
  reference-image-cache/
  generated/
    ocr-golden/
    slab-regression/
    raw-regression/
```

Keep the repo version as:

```text
qa/
  manifests/
  truth/
  lightweight summaries/
```

### 3. Add consistent path overrides everywhere

Standardize on env vars and optional override files:

- `SPOTLIGHT_DATASET_ROOT`
- `SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT`
- `SPOTLIGHT_RAW_VISUAL_TRAIN_EXCLUDED_ROOT`
- `SPOTLIGHT_RAW_LAYOUT_FIXTURE_ROOT`
- `SPOTLIGHT_SLAB_REGRESSION_ROOT`
- `SPOTLIGHT_INCOMING_OCR_FIXTURE_ROOT`
- `SPOTLIGHT_INCOMING_SLAB_FIXTURE_ROOT`
- `SPOTLIGHT_REFERENCE_IMAGE_CACHE_ROOT`
- `SPOTLIGHT_GENERATED_QA_OUTPUT_ROOT`

The raw footer test already has this pattern. Reuse it for slab and other QA
surfaces.

The raw visual training workflow now has a concrete local-first implementation:

- default accepted root: `~/spotlight-datasets/raw-visual-train`
- default excluded root: `~/spotlight-datasets/raw-visual-train-excluded`
- bulk import command:
  - `zsh tools/import_raw_visual_train_batch.sh /path/to/images /path/to/cards.tsv`
- supported import headers:
  - `file_name`, `card_name`, `number`, `set promo`

See [docs/raw-visual-local-dataset-workflow-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-local-dataset-workflow-2026-04-12.md).

Important architecture rule:

- do not hardcode repo paths or cloud bucket paths into the raw training tools
- treat storage location as config
- GCS/object storage may be the source of truth, but the active training and
  normalization tools should target a configurable local working root

### 4. Use object storage for shared team datasets

For collaboration, store real images in:

- GCS
- S3
- Cloudflare R2

Store only:

- manifest JSON
- object keys / URLs
- truth labels
- version identifiers

in the repo.

## Migration Plan

### Phase 0: Freeze new binary sprawl

Immediately stop adding more large QA images or generated outputs to Git.

Actions:

- add ignore rules for generated QA outputs that are still being written inside
  tracked directories
- do not commit new `normalized.jpg`, scorecards, overlays, or downloaded
  reference caches

### Phase 1: Move generated outputs first

Lowest-risk cleanup.

Actions:

- redirect generated OCR/regression output roots to `~/spotlight-datasets/generated`
- update scripts/tests to write there by default
- keep the repo only for source fixtures + manifests during the transition

Expected result:

- fewer noisy file modifications
- no more accidental binary churn in PRs

### Phase 2: Move source fixture images out of repo

Actions:

- create repo-kept manifests that point to external source image paths
- add slab regression path override support like the raw fixture tests already have
- move:
  - `qa/raw-footer-layout-check` image sources
  - `qa/incoming-slab-regression`
  - `qa/incoming-ocr-fixtures`
  - future held-out slab captures
  to `~/spotlight-datasets/...`

Keep in repo:

- truth JSON
- fixture manifests
- lightweight summaries

### Phase 3: Move reference-image caches out of repo

Actions:

- standardize one external cache root for provider-downloaded images
- update training/build scripts to default to that cache root
- update any manifest generation to store either:
  - object URL only
  - or external local absolute path outside repo

### Phase 4: Clean Git history

Once the working tree is clean and no code depends on tracked binaries:

- use `git filter-repo` to purge historical binary QA assets and generated
  outputs from Git history
- force-push once the team is aligned

Likely purge targets:

- `qa/ocr-golden`
- generated runtime artifacts under `qa/raw-footer-layout-check`
- tracked slab regression outputs under `qa/slab-regression/simulator-vision-v1`
- any obsolete incoming image dumps that have been moved to external storage

This is the step that actually shrinks GitHub clone/fetch size.

## Immediate Cleanup Candidates

These are the best first removals from tracked Git payload once replacement paths
exist:

- `qa/ocr-golden/**`
- `qa/slab-regression/simulator-vision-v1/**`
- generated JSON/JPG outputs inside `qa/raw-footer-layout-check/**`

These are the best first relocations out of repo:

- `qa/raw-footer-layout-check/**/source_scan.jpg`
- `qa/incoming-slab-regression/*.jpg`
- `qa/incoming-ocr-fixtures/*.jpg`

These should remain local-only and outside the repo tree:

- `backend/data/**`
- `~/spotlight-datasets/raw-visual-train/**`
- `~/spotlight-datasets/raw-visual-train-excluded/**`
- provider reference-image caches

## Recommended Order

1. Add consistent dataset/output root overrides to slab + remaining QA tools.
2. Move generated outputs out of tracked `qa/` paths.
3. Move source fixture images to an external dataset root.
4. Keep only manifests/truth metadata in Git.
5. Move reference-image caches out of repo.
6. Purge old binary history with `git filter-repo`.

## Bottom Line

The repo does **not** need to store large card datasets for runtime correctness.

The main GitHub bloat is QA fixture history and generated artifact churn, not the
live app/backend architecture. The clean fix is:

- provider APIs + SQLite for runtime
- external dataset root / object storage for images
- Git only for code, manifests, truth labels, and small summaries
