# Raw Visual Hybrid Migration Spec

Date: 2026-04-11

## Status

- This document is the source of truth for the next raw-card identification architecture.
- The next concrete implementation phase after the first landed hybrid baseline is now documented in [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md).
- It replaces the older OCR-primary raw-matcher direction as the planning source of truth for future raw identity work.
- This document also supersedes the earlier heavier implementation phasing that front-loaded backend refactors and harness expansion before proving visual matching on the real normalized scan outputs.
- Raw scanner runtime now defaults to the hybrid resolver path. The iOS scanner runtime explicitly sends `rawResolverMode=hybrid`, and the backend treats omitted raw resolver mode as `hybrid` as well, so end-to-end raw testing exercises visual retrieval first and OCR reranking second.
- The migration goal is to move from:
  - OCR-primary raw identification
- to:
  - visual-match-primary raw identification with OCR confirmation and reranking

## Why This Shift Exists

- The current raw OCR regression seed suite under [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check) is now large enough to show the failure pattern clearly:
  - exact collector OCR is not reliable enough to be the primary card identifier
  - set hint OCR is materially weaker than collector OCR
  - repeated ROI nudging and OCR tuning is producing diminishing returns
- The current normalized card image is a stronger identity signal than footer text alone.
- OCR still matters, but its best role is:
  - confirming the visually matched candidate
  - breaking ties among visually similar printings
  - supplying extra evidence to the backend confidence model

## Current Regression Baseline

Current seed corpus:

- root: [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check)
- fixture shape:
  - one folder per image
  - `source_scan.jpg`
  - `truth.json`

Current seed baseline from [raw_ocr_regression_scorecard.json](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check/raw_ocr_regression_scorecard.json):

- processed fixtures: `67`
- exact collector pass: `31/67`
- set hint pass: `11/67`
- backend recoverable pass: `21/67`

Important:

- the current `backend recoverable` metric is still a heuristic proxy in [RawOCRRegressionSuiteTests.swift](/Users/stephenchan/Code/spotlight/SpotlightTests/RawOCRRegressionSuiteTests.swift)
- the first implementation step is now a proof-of-concept against the live normalized images, not a large harness rewrite before visual matching has been proven

## Core Decisions

- Keep the current app-side front half:
  - target selection
  - perspective normalization
  - normalized card image generation
- Keep the current raw OCR pipeline:
  - it remains required
  - it becomes a tiebreaker and evidence generator, not the primary identity engine
- Raw identification becomes:
  1. visual match from normalized image
  2. OCR rerank and confirm
  3. backend returns best candidate plus alternatives
- Slab scanning stays separate and unchanged by this migration.
- Do not start with on-device CLIP or a bundled visual database in the app.
- Do not add more ROI tuning loops as the main raw-identification strategy.
- Do not add per-card or per-set hacks.

## What Stays

- [Spotlight/Services/OCR/TargetSelection.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/TargetSelection.swift)
- [Spotlight/Services/OCR/PerspectiveNormalization.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/PerspectiveNormalization.swift)
- [Spotlight/Services/OCR/Raw/RawPipeline.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawPipeline.swift)
- [Spotlight/Services/OCR/Raw/RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)
- the normalized card image artifact `06_ocr_input_normalized.jpg`
- the regression harness and fixture layout
- the backend candidate-ranking/disambiguation responsibility
- the raw-only provider lane:
  - raw identity/reference/pricing now move toward the Scrydex-first lane
  - generic broad-text `setHints` are no longer the desired end state for raw set evidence

## What Changes

### Before

```text
App OCR
  -> collector/set/title evidence
  -> backend title/collector retrieval
  -> footer rerank
  -> best guess
```

### After

```text
App normalization + OCR
  -> normalized card image + OCR evidence to backend
  -> backend visual embedding for query image
  -> backend top-K visual candidates
  -> backend OCR-based rerank and confirmation
  -> best candidate + alternatives
```

## Canonical Raw Runtime Architecture

### App responsibilities

- capture preview frame / fallback still image as today
- select target card
- perspective-normalize the card
- generate the normalized raw card image
- run local OCR over the normalized card
- send both:
  - normalized image
  - OCR evidence payload
  to the backend

### Backend responsibilities

1. compute a visual embedding for the normalized query image
2. search the visual reference index for top-K nearest cards
3. rerank those candidates using OCR evidence:
   - collector number
   - set hints
   - title/header text
4. return:
   - top candidate
   - top alternatives
   - confidence
   - reasons / ambiguity flags
5. hydrate pricing and cache card metadata as today

## OCR Role After Migration

OCR is still valuable. It just stops carrying the whole raw-identification problem.

OCR should now optimize for:

- collector-number confirmation
- set-hint confirmation
- title/header confirmation
- ambiguity reduction among visually similar cards

OCR should stop being treated as:

- the primary source of truth for raw identity
- the thing that must stand alone on tiny footer text
- the main place to keep spending time on ROI whack-a-mole

## OCR Change Policy During This Migration

- Do not make OCR parameter, ROI, preprocessing, or parser changes without regression results.
- The regression question remains mandatory:
  - `Do we have regression suite results for this change?`
- The currently approved OCR direction is:
  - keep the current rewrite raw path
  - fix only low-risk generic issues that improve OCR as a tiebreaker
  - do not keep expanding footer-family tuning as the primary raw-identification strategy

Current note:

- several of the previously proposed cheap OCR fixes are already present in the live code:
  - repeated slash collapse in [CardIdentifierParsing.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardIdentifierParsing.swift)
  - `topCandidates(3)` for footer metadata in [RawOCRPassRunner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift)
  - fuzzy alpha-only set-hint matching in [RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)

## Regression Suite Source Of Truth

The user-provided photos under [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check) are now the canonical seed raw regression suite.

That suite must remain:

- preserved
- rerunnable
- diffable
- the first gating suite for raw matcher changes

### Fixture format

Each fixture folder should contain:

- `source_scan.jpg`
- `truth.json`

Minimum `truth.json` contract:

```json
{
  "cardName": "Team Rocket's Weezing",
  "collectorNumber": "199/182",
  "setCode": "DRI"
}
```

### Required suite outputs

- Phase 0-3 may use a lighter-weight scorecard script while the visual path is being proven.
- After the hybrid resolver exists, the fuller fixture outputs should include:
  - per-fixture OCR result JSON
  - per-fixture backend result JSON
- root scorecard with:
  - OCR exact collector accuracy
  - OCR set-hint accuracy
  - visual top-1 accuracy
  - visual top-5 contains-truth rate
  - hybrid top-1 accuracy
  - hybrid top-3 contains-truth rate
  - latency summary

### Required comparison modes

- early proof-of-concept:
  - visual-only retrieval on the provider-supported subset
- later gated suite:
  - current OCR-primary backend resolver
  - visual-only retrieval
  - hybrid visual + OCR rerank resolver

### Phase 0 measurement constraints

- Phase 0 must score the normalized card image produced by the live raw pipeline, not raw `source_scan.jpg`, unless a fixture is missing a normalized output and must be materialized first.
- Phase 0 must build a fixture-to-provider reference mapping before scoring.
- Phase 0 must report provider-supported and provider-unsupported fixture counts separately.
- Do not hardcode hybrid thresholds or OCR bonus scales until the initial visual score distributions are observed.

### Current Phase 0 result

The initial local proof-of-concept is now complete on the current seed corpus using:

- live `runtime_normalized.jpg` query images from the rewrite raw path
- a provider mapping manifest at [qa/raw-footer-layout-check/provider_reference_manifest.json](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check/provider_reference_manifest.json)
- a local CLIP scorecard at [qa/raw-footer-layout-check/raw_visual_poc_scorecard.json](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check/raw_visual_poc_scorecard.json)

Current Phase 0 numbers:

- total fixtures: `67`
- provider-supported fixtures: `47`
- provider-unsupported fixtures: `20`
- visual top-1 accuracy on supported fixtures: `39/47` (`83.0%`)
- visual top-5 contains-truth rate on supported fixtures: `41/47` (`87.2%`)

Decision:

- Phase 0 is a go.
- The next implementation step is the full offline reference index build, not more OCR tuning.

Current local commands:

- `zsh tools/run_raw_visual_poc.sh`
- `zsh tools/run_build_raw_visual_index.sh`

## Visual Reference Index Design

The raw matcher needs a reference image embedding corpus for known cards.

### Inputs

- Pokémon TCG API metadata
- Pokémon TCG API card image URLs
- later, optional provider-specific supplemental image sources if coverage gaps require it

### Reference artifact requirements

The reference index must be:

- generated offline
- versioned
- reproducible
- loadable by the backend
- not a checked-in giant repo artifact
- not an app-bundled runtime dependency for Phase 1

### Storage decision

Do not expand the main runtime SQLite correctness model beyond the three transactional tables.

Instead, treat the visual index as a separate read-only backend artifact, for example:

- a dedicated SQLite sidecar
- or an `npz`/binary vector file plus metadata manifest

That keeps the runtime transactional DB simple while still supporting visual matching.

### Required fields

- `card_id`
- `provider_card_id`
- `name`
- `set_code`
- `collector_number`
- `image_url`
- `embedding_model`
- `embedding_vector`
- `artifact_version`
- `created_at`

## Hybrid Scoring Model

The hybrid resolver should score the top-K visually matched candidates using both visual and OCR signals.

Initial combined signals:

- visual similarity
- exact collector match bonus
- collector near-miss bonus
- set hint match bonus
- title match bonus
- contradiction penalty when OCR strongly disagrees

Initial behavioral rules:

- when visual similarity is very strong and there is a clear margin, visual wins
- when multiple visual candidates are close, OCR breaks ties
- when OCR strongly contradicts the top visual candidate and clearly supports a nearby alternative, the alternative may win
- when visual index is unavailable, the backend may fall back to the current OCR-primary resolver

Weight tuning must happen only by regression results, not intuition.

## Cleanup And Refactor Rules

This migration is also a cleanup project. Do not just layer more raw-matcher logic into the current files indefinitely.

### Required cleanup principles

- isolate the existing OCR-primary raw resolver behind a clearly named compatibility module
- add the new visual matcher behind a separate module boundary
- make the hybrid orchestrator the only place that combines visual and OCR evidence
- avoid adding new raw-identification logic directly into unrelated OCR files
- do not expand `resolverPath = visual_fallback` compatibility naming forever

### Target backend module split

The exact filenames may vary, but the backend should move toward:

- one module for raw OCR evidence / OCR-side scoring helpers
- one module for visual index loading and nearest-neighbor search
- one module for hybrid rerank and confidence
- `server.py` as orchestration, request handling, and response encoding only

The goal is to stop `backend/catalog_tools.py` from remaining the home for every raw matching concern forever.

### Deletion policy

Do not delete the current OCR-primary raw resolver on day one.

Delete or demote old paths only after:

1. the hybrid resolver is implemented
2. the regression suite can compare OCR-only vs visual-only vs hybrid
3. the hybrid resolver is net-positive on the regression suite
4. the app/backend contract for normalized image upload is stable

After that:

- remove OCR-primary raw matching as the default runtime path
- remove misleading compatibility labels where possible
- delete dead raw-only routing/helpers that no longer participate in hybrid resolution
- keep only debug tools that still explain the shipped path
- schedule a post-cutover cleanup pass explicitly; cleanup is not optional follow-up work

### Post-cutover cleanup requirements

Once hybrid is the proven default raw path:

- delete misleading compatibility naming such as `visual_fallback` where it no longer reflects reality
- remove dead raw resolver code that exists only for the OCR-primary path
- remove tests and scripts that only validate deleted raw resolver behavior
- keep the regression corpus and scorecard tooling as long-term quality gates
- update docs again so no file still describes OCR-primary raw matching as the current path
- do not begin large additional raw feature work until this cleanup pass is complete

## Phase Plan

### Phase 0: Proof Of Concept On Live Normalized Images

Goal:

- answer whether visual matching works on the actual normalized query images this app produces

Work:

- identify the unique cards represented in [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check)
- materialize or reuse live normalized query images for those fixtures
- build a fixture-to-provider reference mapping manifest for the provider-supported subset
- download official reference images for the mapped cards
- compute visual embeddings for:
  - the normalized query images
  - the official reference images
- score top-1 and top-5 visual retrieval on the provider-supported subset
- print a simple local scorecard and go/no-go decision

Done when:

- we know whether visual top-5 retrieval is strong enough to justify the rest of the migration
- we have observed real similarity score distributions on the live normalized images

### Phase 1: Full Reference Index Buildout

Goal:

- build the complete backend-loadable visual reference artifact once the proof-of-concept is good enough

Work:

- fetch card metadata and image URLs from the active raw provider lane
- download the full provider-supported reference image set
- compute one full-card embedding per reference image
- write the versioned visual index artifact
- rerun the visual-only scorecard against the full index

Current implementation note:

- the local offline builder now lives at [tools/build_raw_visual_index.py](/Users/stephenchan/Code/spotlight/tools/build_raw_visual_index.py)
- the local runner wrapper now lives at [tools/run_build_raw_visual_index.sh](/Users/stephenchan/Code/spotlight/tools/run_build_raw_visual_index.sh)
- the artifact contract is:
  - `visual_index_<version>_<model>.npz`
  - `visual_index_<version>_manifest.json`
  - `visual_index_<version>_build_report.json`
- default output root is `backend/data/visual-index/`

### Current Phase 1 result

The first full reference index build is now complete.

Artifacts:

- [visual_index_v001_clip-vit-base-patch32.npz](/Users/stephenchan/Code/spotlight/backend/data/visual-index/visual_index_v001_clip-vit-base-patch32.npz)
- [visual_index_v001_manifest.json](/Users/stephenchan/Code/spotlight/backend/data/visual-index/visual_index_v001_manifest.json)
- [visual_index_v001_build_report.json](/Users/stephenchan/Code/spotlight/backend/data/visual-index/visual_index_v001_build_report.json)

Build summary:

- catalog cards retained: `20,237`
- embedded entries: `20,182`
- skipped entries: `55`
- build device: `mps`
- build batch size: `128`
- download workers: `16`

The seed corpus was then rescored against the full index in:

- [raw_visual_full_index_scorecard.json](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check/raw_visual_full_index_scorecard.json)

Current full-index visual-only baseline:

- provider-supported fixtures: `47`
- provider-unsupported fixtures: `20`
- visual top-1 accuracy: `22/47` (`46.8%`)
- visual top-5 contains-truth rate: `28/47` (`59.6%`)
- visual top-10 contains-truth rate: `32/47` (`68.1%`)

Important interpretation:

- the small Phase 0 seed-reference result proved the idea was viable
- the full-index result is the real Phase 1 baseline
- the large drop versus Phase 0 means the next work must focus on:
  - backend visual-only integration for real comparisons
  - then hybrid reranking
  - and likely later experiments such as artwork-crop embeddings

Artwork-crop experiment result:

- [raw_visual_full_index_artwork_v1_scorecard.json](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check/raw_visual_full_index_artwork_v1_scorecard.json)
- top-1 accuracy: `15/47` (`31.9%`)
- top-5 contains-truth rate: `26/47` (`55.3%`)

Interpretation:

- the fixed central artwork crop is worse than the full-card baseline on the real full index
- do not switch the visual lane to this crop
- if cropping is revisited later, it should be content-rect-aware or treated as an additional lane rather than a replacement

Done when:

- the backend can load the reference index locally
- the full-index visual-only baseline is recorded

### Phase 2: Visual-Only Backend Prototype

Goal:

- add visual-only retrieval to the backend without changing the app yet

Work:

- add a backend visual-match path that takes the normalized query image
- compute query embedding
- return top-K visual matches with scores
- expose it behind a resolver mode on the existing raw endpoint for testing
- keep the app contract unchanged during this phase

Done when:

- local and test tooling can compare current OCR-primary resolution versus visual-only retrieval

### Phase 3: Lightweight Three-Way Scorecard

Goal:

- compare OCR-only and visual-only before adding hybrid reranking

Work:

- add a simple backend-side scorecard script that runs the fixture corpus through:
  - OCR-only current resolver
  - visual-only resolver
- print:
  - top-1 accuracy
  - top-5 contains-truth rate

### Current Phase 3/4 result

The first hybrid visual + OCR reranker is now wired and scored on the provider-supported subset.
One regression-harness bug was also fixed during this pass: the hybrid runner no longer falls back to fixture truth for `collectorNumber` when OCR failed to read an exact collector value. The pre-fix `31/47` hybrid number was inflated by that leak and should not be treated as the real baseline.

Scorecard:

- [raw_visual_hybrid_regression_scorecard.json](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check/raw_visual_hybrid_regression_scorecard.json)

Current regression numbers on the `47` provider-supported fixtures:

- visual top-1: `22/47` (`46.8%`)
- visual top-5 contains-truth: `28/47` (`59.6%`)
- visual top-10 contains-truth: `32/47` (`68.1%`)
- honest post-harness-fix hybrid baseline: `28/47` (`59.6%`)
- current hybrid top-1 after leader protection + fuzzy-set dampening: `30/47` (`63.8%`)
- current hybrid top-5 contains-truth: `31/47` (`66.0%`)
- visual ceiling at larger `K`:
  - top-20 contains-truth: `35/47` (`74.5%`)
  - top-30 contains-truth: `35/47` (`74.5%`)
  - top-50 contains-truth: `35/47` (`74.5%`)

Interpretation:

- hybrid reranking materially improves top-1 over visual-only
- the current hybrid path no longer regresses any fixture where visual top-1 was already correct
- leader protection recovered `whimsicott-vstar-175-172-slight-angle`
- fuzzy-vs-exact set-hint dampening recovered `sabrinas-slowbro-60-132`
- widening the visual pool above `K=10` increases ceiling slightly but hurts hybrid top-1
- visual retrieval is now the primary bottleneck, not OCR extraction
- the next workstream is the visual-model-improvement phase in [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
- current follow-on result from that next phase:
  - the last PokemonTCG-backed checkpoint `v003-b8` improved the runtime-shaped regression to:
    - visual top-1: `24/47`
    - visual top-10 contains-truth: `37/47`
    - hybrid top-1: `32/47`
  - the promoted Scrydex-backed active runtime is now `v004-scrydex-b8` plus matcher shortlist improvements:
    - visual top-1: `25/67`
    - visual top-10 contains-truth: `40/67`
    - hybrid top-1: `36/67`
  - see [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md) for the current runtime/default wiring and follow-up work

Done when:

- we have the baseline comparison that justifies building the hybrid reranker

### Phase 4: Hybrid Resolver

Goal:

- make visual matching the primary raw-identification path

Work:

- combine:
  - visual top-K candidates
  - OCR evidence
  into one hybrid resolver
- rerank visually matched candidates using OCR evidence
- extract cleaner backend seams only as they become necessary while building this path
- return:
  - best candidate
  - top alternatives
  - confidence
  - reasons

Done when:

- the hybrid path is feature-flagged
- the scorecard can compare:
  - OCR-only
  - visual-only
  - hybrid

### Phase 5: App Integration

Goal:

- send the right data to the backend without changing the capture model

Work:

- keep existing raw OCR on-device
- send normalized card image plus OCR evidence to the backend
- preserve current scan UX
- expose top alternatives in the response model if needed

Done when:

- app/backend request and response contracts are stable
- the shipped path can exercise the hybrid resolver end to end

### Phase 6: Expand The Regression Harness And Tune

Goal:

- improve hybrid accuracy by measurement and harden the tooling after the hybrid path exists

Work:

- expand the scorecard into the fuller per-fixture artifact suite if needed
- compare full-card normalized input versus artwork crop
- tune hybrid rerank weights
- inspect remaining failure buckets:
  - art-too-similar
  - image quality too low
  - provider coverage gaps
  - OCR contradictions

Done when:

- hybrid materially outperforms the OCR-primary resolver on the regression suite

### Phase 7: Cutover And Delete Legacy Raw Paths

Goal:

- stop carrying two competing raw-identification architectures indefinitely

Work:

- make hybrid the default raw resolver
- demote OCR-primary raw matching to temporary fallback only if still needed
- remove dead raw matcher routes and misleading compatibility labels
- update docs and status files

Done when:

- hybrid is the default path
- old OCR-primary raw matcher is no longer the normal runtime path

## Success Criteria

This migration is successful when all of the following are true:

- the raw regression suite uses the user-provided photo corpus as a real gating suite
- the backend can score current OCR-only, visual-only, and hybrid paths on the same fixtures
- the hybrid resolver is measurably better than the OCR-primary resolver
- the normalized image is a first-class backend input for raw scans
- OCR is still present but no longer treated as the sole raw identity engine
- the raw codebase is cleaner, with fewer overlapping matcher paths

## What Not To Do

- do not keep tuning OCR as if OCR will remain the primary raw identifier
- do not reintroduce bundled backend catalog artifacts as runtime correctness dependencies
- do not build the first version as on-device CLIP
- do not add per-card or per-set routing hacks to compensate for weak architecture
- do not delete the current raw resolver before the hybrid path is regression-proven
- do not let the app and backend drift into multiple contradictory raw-identification contracts
