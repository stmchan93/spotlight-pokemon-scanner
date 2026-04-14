# Raw Visual Local Dataset Workflow

This doc defines the local-first workflow for bulk raw visual training imports.

## Goals

- keep large raw training image sets out of the GitHub repo
- make bulk imports from a simple spreadsheet easy
- keep the existing raw visual manifest and training pipeline intact

## Default local roots

By default, raw visual training data should live outside the repo under:

```text
~/spotlight-datasets/raw-visual-train
~/spotlight-datasets/raw-visual-train-excluded
```

Override these when needed with:

- `SPOTLIGHT_DATASET_ROOT`
- `SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT`
- `SPOTLIGHT_RAW_VISUAL_TRAIN_EXCLUDED_ROOT`

These are working-copy roots, not hardcoded storage backends.

Recommended model:

- object storage like GCS can be the source of truth
- a local filesystem root is the active training workspace
- the tooling should point at the local working root through env vars
- if the source of truth moves, only the env/config or sync step should change

The current training and normalization tools operate on local files, so a GCS
bucket should be synced or mounted into the active local working root rather
than hardcoded directly into the Python or Swift tooling.

## Supported bulk import manifest

The importer now supports CSV or TSV files with headers like:

```text
file_name, card_name, number, set promo
```

or

```text
file_name	card_name	number	set promo
```

Example rows:

```text
IMG_9580	Special Delivery Pikachu	SWSH074	SWSD
IMG_9574	Jolteon VMAX	SWSH184	SWSD
IMG_9573.HEIC	Raging Bolt ex	208/162	TEF
```

Accepted image formats:

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.heic`
- `.heif`

The importer resolves either full filenames or bare stems like `IMG_9580`.

## One-command import flow

```bash
zsh tools/import_raw_visual_train_batch.sh /path/to/images /path/to/cards.tsv
```

That command now:

1. imports the images into the local raw training root
2. creates stable fixture directories
3. writes `truth.json` from the manifest row
4. writes `import_metadata.json`
5. converts non-JPEG sources into `source_scan.jpg`
6. runs runtime normalization artifacts
7. runs conservative auto-label review
8. rebuilds the raw visual training manifest

## Recommended staged batch intake

For recurring bulk drops, prefer the staged batch processor over direct import:

```bash
python3 tools/process_raw_visual_batch.py \
  --spreadsheet /path/to/CardPhotosSpreadsheet.xlsx \
  --photo-root /path/to/drive-download-folder \
  --training-root "$SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT" \
  --excluded-root "$SPOTLIGHT_RAW_VISUAL_TRAIN_EXCLUDED_ROOT" \
  --heldout-root qa/raw-footer-layout-check \
  --import-safe
```

That flow:

1. reads the spreadsheet
2. resolves filenames against the batch photo folder
3. detects held-out truth overlap, excluded overlap, exact-hash duplicates, and broken source images
4. writes staged manifests under:
   - `<active-training-root>/batch-audits/<batch-id>/`
5. updates the persistent dedupe registry:
   - `<active-training-root>/raw_scan_registry.json`
6. imports only:
   - `safe_new`
   - `safe_training_augment`
7. leaves:
   - `heldout_blocked`
   - `manual_review`
   out of accepted training fixtures

The registry is the running record for future drops. It tracks:

- file hash
- source filename
- normalized `card_name + number + set`
- batch id
- dataset status
- reason
- imported fixture path
- timestamps

This is the preferred path when new spreadsheets will keep arriving over time.

## Fixture naming

Imported fixture directories now use:

```text
<card-name-slug>-<collector-number-slug>-<set-code-slug>-<source-image-stem>
```

Example:

```text
special-delivery-pikachu-swsh074-swsd-img-9580
```

This keeps duplicate photos of the same card easy to distinguish.

## Angle metadata

Angle metadata is optional for this import workflow.

Multiple photos of the same truth card are still useful because the training
manifest groups fixtures by:

- `cardName`
- `collectorNumber`
- `setCode`

The manifest does not require an explicit angle field. The image variation still
matters, but the import sheet does not need to encode it.

## Current local continuity option

If you already have an active repo-local corpus and want continuity before
migrating to `~/spotlight-datasets`, point the env vars at the existing roots:

```bash
export SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT="$PWD/qa/raw-visual-train"
export SPOTLIGHT_RAW_VISUAL_TRAIN_EXCLUDED_ROOT="$PWD/qa/raw-visual-train-excluded"
```

That keeps the workflow config-driven while preserving the current working set.

## Related files

- [tools/process_raw_visual_batch.py](/Users/stephenchan/Code/spotlight/tools/process_raw_visual_batch.py)
- [tools/import_raw_visual_training_photos.py](/Users/stephenchan/Code/spotlight/tools/import_raw_visual_training_photos.py)
- [tools/import_raw_visual_train_batch.sh](/Users/stephenchan/Code/spotlight/tools/import_raw_visual_train_batch.sh)
- [tools/build_raw_visual_training_manifest.py](/Users/stephenchan/Code/spotlight/tools/build_raw_visual_training_manifest.py)
- [tools/templates/raw_visual_import_template.tsv](/Users/stephenchan/Code/spotlight/tools/templates/raw_visual_import_template.tsv)
