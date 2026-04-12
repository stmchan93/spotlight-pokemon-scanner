# Raw Visual Model Improvement Spec

Date: 2026-04-11

## Status

- This document is the source of truth for the next raw-card improvement phase after the first hybrid visual + OCR baseline.
- It does not replace [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md) as the architecture document.
- It defines the concrete next implementation phase for improving visual retrieval quality.
- The current shipped raw runtime should remain unchanged until this phase proves a net-positive result on the held-out regression suite.
- The first tool in this phase is now landed:
  - [tools/build_raw_visual_training_manifest.py](/Users/stephenchan/Code/spotlight/tools/build_raw_visual_training_manifest.py)

## Frozen Decisions

These are fixed until a new visual model proves better on the same held-out suite.

- Canonical held-out raw regression suite:
  - [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check)
- Current honest best hybrid baseline:
  - visual-only top-1: `22/47` (`46.8%`)
  - visual-only top-5 contains-truth: `28/47` (`59.6%`)
  - visual-only top-10 contains-truth: `32/47` (`68.1%`)
  - hybrid top-1: `30/47` (`63.8%`)
  - hybrid top-5 contains-truth: `31/47` (`66.0%`)
- Visual ceiling sweep with the current model:
  - top-20 contains-truth: `35/47` (`74.5%`)
  - top-30 contains-truth: `35/47` (`74.5%`)
  - top-50 contains-truth: `35/47` (`74.5%`)
- Runtime decision:
  - keep visual retrieval `top-K = 10`
  - do not widen the runtime pool to `20`
  - widening helped visual ceiling slightly but hurt hybrid top-1
- OCR decision:
  - stop spending major effort on OCR extraction tuning
  - OCR is now secondary evidence, not the main limiter

## Why This Phase Exists

The current bottleneck is visual retrieval, not OCR reranking.

Evidence:

- The current hybrid system already improved top-1 materially over visual-only.
- At `K=20`, `12` of the remaining supported-fixture failures still do not contain the truth card in the visual pool.
- OCR cannot promote a card that is not in the candidate pool.
- The current visual ceiling flattens by `K=20`, which means the current base model is the limiting factor.

Therefore:

- the next investment must be better scan-to-reference visual embeddings
- not more top-K widening
- not more OCR whack-a-mole

## Goal

Improve the visual embedding model so that:

1. the held-out visual candidate ceiling rises above the current `35/47`
2. the current hybrid reranker benefits from a better candidate pool without changing OCR extraction first

## Non-Goals

This phase does **not** include:

- OCR ROI changes
- OCR preprocessing changes
- parser tweaks unrelated to the visual model
- app contract changes
- slab changes
- runtime cleanup / deletion of old compatibility paths
- increasing runtime `top-K`

## Success Criteria

The new visual model candidate is a keep only if it is net-positive on the held-out suite.

Minimum keep gate:

- visual top-10 contains-truth improves by at least `+3` fixtures over `32/47`
- hybrid top-1 improves by at least `+2` fixtures over `30/47`
- runtime `top-K = 10` is still used during evaluation

Stretch goal:

- visual top-10 contains-truth reaches `38-40/47`
- hybrid top-1 reaches `34-38/47`

Failure / stop conditions:

- visual top-10 stays `<= 35/47`
- hybrid top-1 stays `<= 30/47`
- improvements only appear on a contaminated train/eval split instead of the held-out suite

## Critical Data Rule

Do **not** train on [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check).

That corpus is now the held-out quality gate.

If a larger labeled raw-photo corpus does not yet exist:

- implement the tooling in this spec
- do not claim model improvement
- stop before training

## Required Training Corpus

Create a separate corpus outside the held-out suite.

Recommended root:

- `qa/raw-visual-train/`

Recommended minimum:

- `100+` unique cards
- `3` images per card
- `300+` normalized scans

Better target:

- `200+` unique cards
- `600+` normalized scans

### Fixture Shape

Use the same basic fixture contract as the held-out suite:

- one folder per image
- `source_scan.jpg`
- `truth.json`

Then materialize these generated artifacts with the live raw pipeline:

- `runtime_normalized.jpg`
- `runtime_selection_summary.json`
- optional debug artifacts if needed

### Truth Contract

Minimum `truth.json`:

```json
{
  "cardName": "Team Rocket's Weezing",
  "collectorNumber": "199/182",
  "setCode": "DRI"
}
```

The corpus must then be mapped to provider card IDs using the same provider-reference-mapping approach already used for the held-out suite.

## Data Splits

Use three separate data surfaces:

1. `qa/raw-visual-train/`
   - model training inputs
2. validation split inside the training corpus
   - early stopping and model selection
3. `qa/raw-footer-layout-check/`
   - final held-out regression gate only

Important:

- split by `providerCardId`, not by image
- images of the same card cannot appear across both train and validation
- the held-out suite must remain completely isolated

## Model Design V1

Start with the smallest useful model change.

Do **not** begin with full CLIP fine-tuning.

### Base encoder

- keep `openai/clip-vit-base-patch32`
- keep the current image preprocessing contract used by the current visual matcher
- keep the current 512-dim base embedding

### Trainable component

Train a shared projection adapter on top of the frozen CLIP embedding:

```text
clip_image_embedding (512)
  -> trainable linear projection W (512 x 512)
  -> L2 normalize
  -> retrieval embedding
```

Initialization:

- initialize `W` as identity
- keep the base CLIP image encoder frozen for V1

Optional trainable scalar:

- one temperature / logit-scale parameter for contrastive training

Reason for this design:

- minimal integration risk
- easy to apply to both query images and reference images
- easy to rebuild the reference index
- much cheaper than full backbone fine-tuning

## Training Objective

Use symmetric contrastive retrieval training.

Positive pair:

- normalized raw scan image
- official provider reference image for the same `providerCardId`

Negatives:

- in-batch negatives
- mined hard negatives from the current visual model

Recommended loss:

- InfoNCE / CLIP-style bidirectional contrastive loss

Train both directions:

- scan -> reference
- reference -> scan

## Hard Negative Strategy

Hard negatives are required in V1 because the current failures cluster around visually similar or same-family lookalikes.

Mine negatives from the current baseline model:

1. run the current visual matcher on the training corpus
2. record top wrong candidates per training fixture
3. keep:
   - same-title different-printing confusions
   - same-family / similar-art confusions
   - same-layout trainer/item confusions

Recommended stored count:

- top `5` hard negatives per training fixture

Examples of the failure family this should capture:

- wrong Pikachu VMAX printing
- wrong Dark Weezing printing
- wrong LEGEND half
- wrong trainer/item with similar full-card structure

## Training Hyperparameters V1

Start simple and measurable.

Recommended defaults:

- optimizer: `AdamW`
- learning rate: `1e-3`
- weight decay: `1e-4`
- batch size: `32` or `64` if memory allows
- epochs: `10-20`
- early stopping metric: validation recall@10
- early stopping patience: `3`

Do not optimize for perfect training loss.

Optimize for:

- validation recall@10
- then held-out regression improvement

## Artifact Contracts

### Training manifest

Recommended output:

- `qa/raw-visual-train/raw_visual_training_manifest.jsonl`

Each line should include:

```json
{
  "fixtureName": "team-rockets-weezing-199-182-overhead",
  "providerCardId": "sv10-199",
  "normalizedImagePath": "/abs/path/runtime_normalized.jpg",
  "referenceImageUrl": "https://images.pokemontcg.io/sv10/199_hires.png",
  "referenceImagePath": "/abs/path/reference_cache/sv10-199.png",
  "cardName": "Team Rocket's Weezing",
  "collectorNumber": "199/182",
  "setCode": "DRI"
}
```

### Hard-negative manifest

Recommended output:

- `qa/raw-visual-train/raw_visual_hard_negatives.json`

Shape:

```json
{
  "team-rockets-weezing-199-182-overhead": [
    { "providerCardId": "sv6pt5-89", "similarity": 0.735618 },
    { "providerCardId": "base5-31", "similarity": 0.721000 }
  ]
}
```

### Trained model artifact

Recommended output root:

- `backend/data/visual-models/`

Recommended files:

- `raw_visual_adapter_v001.pt`
- `raw_visual_adapter_v001_metadata.json`

Do not check these artifacts into the repo.

### Rebuilt index artifact

Keep using:

- `backend/data/visual-index/visual_index_<version>_<model>.npz`
- `backend/data/visual-index/visual_index_<version>_manifest.json`
- `backend/data/visual-index/visual_index_<version>_build_report.json`

The only change is that index generation must apply the trained projection to reference embeddings before writing the matrix.

## File-By-File Implementation Plan

### New tooling

1. `tools/build_raw_visual_training_manifest.py`
   - input:
     - one or more training fixture roots
   - work:
     - verify `truth.json`
     - verify `runtime_normalized.jpg`
     - map truth to provider card ID / image URL
     - optionally cache the official reference image locally
     - write JSONL training manifest

2. `tools/mine_raw_visual_hard_negatives.py`
   - input:
     - training manifest
     - current visual model
   - work:
     - run current retrieval over the training corpus
     - record top wrong candidates per fixture
     - write hard-negative manifest

3. `tools/train_raw_visual_adapter.py`
   - input:
     - training manifest
     - hard-negative manifest
   - work:
     - load frozen CLIP
     - train the projection adapter
     - write model artifact + metadata
     - emit train/validation metrics

4. `tools/eval_raw_visual_model.py`
   - input:
     - trained adapter artifact
     - held-out regression suite
   - work:
     - rebuild or virtually apply the improved model
     - score held-out visual top-1 / top-5 / top-10
     - optionally score hybrid with the same `K=10`
     - write a model-eval scorecard

### Shared runtime/model layer

5. `backend/raw_visual_model.py`
   - responsibility:
     - shared image embedding contract for:
       - training
       - index building
       - backend runtime matching
   - should support:
     - base CLIP only
     - CLIP + optional adapter projection

### Existing files to extend

6. [tools/build_raw_visual_index.py](/Users/stephenchan/Code/spotlight/tools/build_raw_visual_index.py)
   - add support for:
     - `--adapter-path`
     - `--adapter-metadata-path`
   - apply the adapter projection when embedding reference images

7. [backend/raw_visual_matcher.py](/Users/stephenchan/Code/spotlight/backend/raw_visual_matcher.py)
   - load the same adapter when configured
   - ensure query images are embedded with the same model path used to build the index

8. [tools/run_raw_visual_hybrid_regression.py](/Users/stephenchan/Code/spotlight/tools/run_raw_visual_hybrid_regression.py)
   - add support for selecting:
     - base model only
     - base model + adapter
   - keep runtime `top-K = 10` as the default during evaluation

## Exact Phase Order

### V0: Freeze and prepare

Done/keep:

- freeze current best hybrid baseline at `30/47`
- keep runtime `top-K = 10`
- do not change OCR extraction logic

### V1: Build training corpus tooling

Implement:

- `tools/build_raw_visual_training_manifest.py`
- provider mapping for the training corpus
- generation of missing `runtime_normalized.jpg` artifacts if needed

Stop here if no new training corpus exists yet.

### V2: Mine hard negatives

Implement:

- `tools/mine_raw_visual_hard_negatives.py`

Output:

- hard-negative manifest from the current baseline model

### V3: Train the adapter

Implement:

- `tools/train_raw_visual_adapter.py`
- `backend/raw_visual_model.py`

Output:

- trained adapter artifact
- metadata
- train/validation metrics

### V4: Evaluate offline on the held-out suite

Implement:

- `tools/eval_raw_visual_model.py`
- adapter-aware index rebuild path
- adapter-aware regression scoring

Measure:

- visual top-1
- visual top-5
- visual top-10
- hybrid top-1
- hybrid top-5

Decision:

- keep only if net-positive against the frozen held-out baseline

### V5: Rebuild the production-shaped visual index

Only after V4 is positive:

- rebuild the full reference index with the improved model
- write a new versioned index artifact, for example:
  - `visual_index_v002_clip-vit-base-patch32-adapter-v001.npz`

### V6: Backend runtime adoption

Only after V5 is positive:

- point runtime visual matching to the new model + index
- rerun:
  - visual-only regression
  - hybrid regression
  - backend decision tests

Do not revisit `top-K` until the new model is measured at `K=10`.

## Validation Contract

Required validation during this phase:

```bash
python3 -m py_compile backend/catalog_tools.py backend/server.py backend/raw_visual_matcher.py
zsh tools/run_raw_ocr_regression_suite.sh
source .venv-raw-visual-poc/bin/activate && python tools/run_raw_visual_hybrid_regression.py
zsh tools/run_raw_card_decision_tests.sh
python3 -m unittest -v backend.tests.test_raw_decision_phase5
```

Additional new validation commands after tooling lands:

```bash
python tools/build_raw_visual_training_manifest.py ...
python tools/mine_raw_visual_hard_negatives.py ...
python tools/train_raw_visual_adapter.py ...
python tools/eval_raw_visual_model.py ...
```

## Decision Rules

Before keeping any new visual-model change:

1. record the frozen baseline
2. train/evaluate the candidate model
3. rerun the held-out visual and hybrid scorecards
4. report:
   - visual top-1 delta
   - visual top-10 delta
   - hybrid top-1 delta
   - hybrid top-5 delta
5. keep the model only if the held-out suite is net-positive

## What To Do After A Win

Only after the improved visual model is measured as a win:

1. rebuild the full index with the improved model
2. keep hybrid as the raw runtime architecture
3. rerun the same held-out suite
4. then revisit:
   - app/backend normalized image contract cleanup
   - raw resolver cleanup
   - deletion of obsolete OCR-primary compatibility paths

## What Not To Do

- do not train on the held-out regression suite
- do not widen runtime `top-K` during this phase
- do not spend this phase on OCR extraction retuning
- do not switch to a different CLIP backbone before the lightweight adapter baseline is measured
- do not claim success from train/validation metrics alone
- do not integrate a new visual model into runtime before held-out regression improvement is proven
