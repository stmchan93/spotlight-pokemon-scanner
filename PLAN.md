# PLAN

Date: 2026-04-11

## Current planning override

- The current raw visual-match-primary migration source of truth is [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md).
- The current next-step implementation source of truth for improving raw visual retrieval is [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md).
- The current backend reset / raw-matcher redesign source of truth is [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- The current backend latency / network-call refactor pre-implementation source of truth is [docs/backend-latency-refactor-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/backend-latency-refactor-spec-2026-04-10.md).
- The current OCR rewrite / rollout source of truth is [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- The current OCR simplification / performance implementation source of truth for the next OCR pass is [docs/ocr-simplification-performance-implementation-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/ocr-simplification-performance-implementation-spec-2026-04-10.md).
- The raw backend reset has now landed.
- The next raw identity direction is now:
  - visual matching first
  - OCR confirmation second
- The revised implementation order is now:
  - Phase 0 proof-of-concept on live normalized images
  - then full reference index buildout
  - then visual-only backend retrieval
  - then hybrid reranking
  - then app contract changes
  - then expanded harness and tuning
  - then deletion/cleanup
- Treat the current backend runtime as:
  - raw-only
  - 3-table SQLite (`cards`, `card_price_snapshots`, `scan_events`)
  - thin provider shells preserved for Pokemon TCG API, Scrydex, and PriceCharting
- Treat the old slab/sync/cache backend modules as deleted legacy state, not as code to revive.
- Treat the current OCR implementation as temporary legacy structure while the new OCR pipeline is planned and evaluated side-by-side.

## Current OCR planning override

- The next OCR rewrite must use:
  - a shared front half
  - a raw branch
  - a slab branch
- Raw OCR is no longer the long-term primary raw identity engine.
- Raw OCR should be treated as:
  - backend evidence generation
  - visual-match tiebreaker
  - ambiguity reduction
- Do not keep expanding raw OCR ROI tuning as the primary raw-identification strategy.
- The next OCR implementation pass should apply the concrete scope in [docs/ocr-simplification-performance-implementation-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/ocr-simplification-performance-implementation-spec-2026-04-10.md):
  - raw = footer-first
  - slab = PSA-only for now
  - local debug artifact export may remain on temporarily while OCR troubleshooting is active
- Top-level OCR routing follows the UI-selected mode:
  - `raw`
  - `slab`
- `raw in holder` is not a separate top-level mode.
  - holder / sleeve / top-loader cases stay inside raw as scene traits
- The new OCR path must be:
  - fixture-first
  - replayable by stage
  - launched behind a feature flag
  - run side-by-side with the old path before old OCR is deleted

## Current slab planning override

- Do **not** expand the current slab path with more one-off card-specific fixes unless a blocker absolutely requires a short-lived quarantine rule.
- The active slab OCR path is now PSA-only by design.
- Non-PSA slabs should return explicit unsupported / needs-review OCR output instead of going through fake generic parsing.
- The current slab rewrite should treat slab OCR as:
  - PSA top-label-focused
  - cert / grade / card-number extraction when PSA evidence is strong
  - fixture-first on PSA slab captures
- Future non-PSA slab families should be rebuilt with their own label parsers, not folded back into shared regex heuristics.

### Hardcoded slab logic to remove or downrank

- App OCR geometry in [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift):
  - one shared `SlabScanConfiguration.LabelOCR` for all graders
  - one shared `SlabScanConfiguration.CardFooterOCR` for all graders
  - one shared `psaLogoRegion` reused even when the slab is not PSA
- App slab label parsing in [Spotlight/Services/SlabLabelParsing.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabLabelParsing.swift):
  - PSA-weighted visual inference scores applied as the main fallback path
  - regex-heavy shared parsing instead of grader-family-specific layouts
  - shared slab-card-number extraction rules instead of family-aware label parsing
- App slab footer set-hint extraction in [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift):
  - `knownAlphaOnlyHints` allowlist (`par`, `svi`, `pgo`, `xyp`, `smp`, `mp`, etc.)
  - slab-relative footer rescue rules should become fallback-only once the card window is localized
- Backend slab matcher in [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py):
  - handwritten slab title abbreviation repair like `PRTD -> PRETEND`, `MGKRP -> MAGIKARP`, `TGPI -> TOGEPI`
  - broad slab title stop-token lists that compensate for weak upstream parsing
  - label-only slab title normalization doing too much identity recovery

### Hardcoded logic that is still acceptable temporarily

- Generic OCR cleanup that is not card-specific:
  - separator normalization
  - hyphen restoration for promo denominators
  - OCR-confusable repair like `O -> 0`, `I/L -> 1` in constrained collector parsing
- Variant-hint parsing that reflects real printed variants rather than specific cards:
  - `shadowless`
  - `1st edition`
  - `red cheeks`
  - `yellow cheeks`
- Manifest-backed denominator and expansion resolution:
  - `020/M-P -> mp_ja`
  - `150/XY-P -> xyp_ja`
  - `094/173 -> sm12a_ja`

### Decision on per-card logic

- Do **not** move slab OCR to a per-card rules engine as the normal design.
- If a tester-blocking card must be unblocked before the architectural reset lands, allow a temporary quarantine rule only if:
  - it is scoped to one clearly named card or cert shape
  - it is marked as temporary in code
  - it has a dedicated regression fixture
  - it is scheduled for deletion once grader-family parsing and inner-card localization land
- Default direction: grader-family profiles plus data-driven set resolution, not per-card heuristics.

## Current milestone status

### Milestone 1: Raw backend reset

Status: `done`

- raw-only backend runtime is landed
- runtime SQLite is simplified to:
  - `cards`
  - `card_price_snapshots`
  - `scan_events`
- raw backend now returns a best candidate even at low confidence

### Milestone 1b: Raw visual hybrid migration

Status: `active`

- user-provided raw photos under [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check) are now the canonical seed raw regression suite
- the new source-of-truth migration plan is [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)
- local Phase 0 proof-of-concept is now complete:
  - provider-supported fixtures: `47`
  - provider-unsupported fixtures: `20`
  - visual top-1: `39/47`
  - visual top-5 contains-truth: `41/47`
- full Phase 1 reference index build is now complete:
  - retained catalog cards: `20,237`
  - embedded entries: `20,182`
  - skipped entries: `55`
  - full-index visual top-1: `22/47`
  - full-index visual top-5 contains-truth: `28/47`
  - full-index visual top-10 contains-truth: `32/47`
- fixed artwork-only crop experiment is now complete:
  - top-1: `15/47`
  - top-5 contains-truth: `26/47`
- first hybrid visual + OCR reranker is now landed and locally scored:
  - honest post-harness-fix hybrid baseline: `28/47`
  - current hybrid top-1 after leader protection + fuzzy-set dampening: `30/47`
  - current hybrid top-5 contains-truth: `31/47`
- visual ceiling sweep is now complete:
  - top-20 contains-truth: `35/47`
  - top-30 contains-truth: `35/47`
  - top-50 contains-truth: `35/47`
  - runtime decision: keep `top-K = 10`
- current local visual tooling:
  - `zsh tools/run_raw_visual_poc.sh`
  - `zsh tools/run_build_raw_visual_index.sh`
  - `python tools/run_raw_visual_hybrid_regression.py`
- next work is:
  - build the separate visual training corpus and manifest tooling
  - train and evaluate a lightweight visual adapter on top of frozen CLIP
  - rebuild the visual index only if the held-out suite improves
  - keep OCR and runtime `top-K = 10` stable during that phase
  - only after a visual-model win, resume app contract work and cleanup
- first landed tool in that phase:
  - `python3 tools/build_raw_visual_training_manifest.py ...`

### Milestone 2: OCR architecture rewrite

Status: `active`

- the source-of-truth OCR rewrite spec is now documented
- shared OCR data contracts are landed
- the stage-artifact writer is landed
- shared front-half extraction is landed:
  - frame source selection
  - target selection
  - perspective normalization
- simulator-backed legacy OCR fixture execution is landed
- mode sanity signals and the OCR coordinator are landed
- raw branch stage 1 is landed behind the rewrite path
- raw escalation and confidence is landed behind the rewrite path
- raw preview-frame-first capture is restored
- raw footer-first staging is landed
- remnant-aware fallback normalization is landed for partial/off-center raw scans
- fallback salvage now re-canonicalizes recovered raw cards into tighter card-filling OCR inputs
- deterministic footer band/corner extraction is the live raw path
- debug artifact `04_selected_target_crop.jpg` is now the chosen/recovered target image, not a duplicate search image
- raw runtime now routes directly through `RawPipeline`
- slab stage 1 is landed as a PSA-only top-label parser with staged fallback
- the current OCR path is still the active runtime path

### Milestone 3: OCR fixture-first rollout

Status: `active`

- concrete hardening follow-up is tracked in [docs/raw-ocr-hardening-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/raw-ocr-hardening-spec-2026-04-10.md)
- fixture manifests and host baseline runner are landed
- stage-local replay artifact wiring is landed
- simulator-backed legacy OCR execution is landed
- mode sanity signals and the OCR coordinator are landed
- simulator-backed rewrite raw stage-1 execution is landed
- raw branch stage 1 is landed
- raw escalation and confidence is landed
- run old vs new OCR side-by-side before cutover

### Milestone 4: Slab/backend rebuild

Status: `deferred`

- slab backend runtime remains removed for now
- slab OCR branch and later slab backend rebuild will follow after OCR contracts settle

### Milestone 5: Slab parser reset

Status: `planned`

- replace shared slab-relative crops with grader-family label profiles plus inner-card localization
- stop letting slab footer OCR operate directly in slab coordinates
- keep set resolution manifest-backed and remove handwritten slab-set allowlists
- expand the slab golden suite beyond the single current fixture before more slab tuning

## Remaining tasks

1. Keep [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md) as the raw identity architecture source of truth.
2. Treat [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md) as the next raw implementation source of truth.
3. Build the separate visual training corpus and manifest tooling without contaminating the held-out regression suite.
4. Train and evaluate the lightweight visual adapter against the frozen held-out baseline.
5. Rebuild the full visual index only if the new model is net-positive on the held-out suite.
6. Keep runtime `top-K = 10` and current OCR extraction stable until the visual model improves.
7. Do human tap-through verification only after the improved visual model is integrated.
8. Run an explicit deletion/cleanup pass after the improved hybrid path is proven better.
9. Only then proceed to slab backend/pricing rebuild on top of the settled raw contract.

## Slab parser reset execution plan

1. Split top-label parsing by slab family.
   - Add explicit label profiles for `PSA`, `CGC`, `BGS`, and `TAG`.
   - Each profile should own:
     - label-region geometry
     - grade/cert parsing order
     - brand detection rules
   - Shared parsing should only handle normalization, not family-specific geometry.

2. Localize the inner card window inside the slab.
   - Detect the actual card rect inside the plastic slab after the slab target is normalized.
   - Move slab footer OCR to run relative to the card rect, not the slab rect.
   - Treat the existing `09`/`10`/`11` slab footer crops as temporary legacy artifacts.

3. Rebuild slab footer OCR as raw-style footer OCR.
   - Reuse the raw footer parsing ideas against the localized inner card window.
   - Prefer collector/set evidence from the actual printed card footer.
   - If the inner card window cannot be localized confidently, do not trust footer OCR strongly.

4. Gate evidence by source quality.
   - If label parsing already yields a strong collector like `SM162`, `020/M-P`, or `153/SV-P`, do not let weak footer OCR override it.
   - If footer OCR disagrees with a strong label collector prefix, treat the footer as weak/noisy evidence.
   - If target normalization falls back badly, downrank footer-derived collector/set hints.

5. Reduce backend slab identity repair.
   - Keep generic title cleanup and variant-hint parsing.
   - Downrank or remove handwritten abbreviation repair once the new slab OCR path is live.
   - Expect the backend to consume:
     - grader
     - grade
     - cert
     - canonical collector number
     - manifest-backed set hints
     rather than invent missing slab identity from the label.

6. Expand the slab regression suite before more tuning.
   - Add bootstrap fixtures for:
     - PSA
     - CGC
     - BGS
     - TAG
   - It is acceptable to start with app-taken scans of slab images shown on a computer display.
   - Mark those fixtures as synthetic/bootstrap coverage and later supplement them with real physical slab captures.

7. Delete the current slab allowlist/crop hacks in order.
   - First: remove shared slab-footer set-hint allowlists once card-window-relative footer OCR is working.
   - Second: reduce slab title abbreviation hacks in the backend.
   - Third: remove grader-mismatched crops like using a PSA-logo crop as a universal slab probe.

## Immediate slab fixture plan

1. Accept user-provided slab screenshots or app-captured screen scans as bootstrap fixtures.
2. Add them under [qa/incoming-ocr-fixtures](/Users/stephenchan/Code/spotlight/qa/incoming-ocr-fixtures).
3. Add manifests under [qa/ocr-fixtures](/Users/stephenchan/Code/spotlight/qa/ocr-fixtures).
4. Rebuild the golden baseline with:
   - `zsh tools/run_ocr_fixture_runner.sh`
5. Treat those fixtures as the source of truth for the slab parser reset, not ad hoc manual tuning.

## Current validation priorities

1. Keep the backend reset validation commands green.
2. Keep the existing Swift parser / reticle / tray test scripts green.
3. Keep both OCR fixture runners green before deleting legacy OCR logic:
   - `zsh tools/run_ocr_fixture_runner.sh`
   - `zsh tools/run_ocr_simulator_fixture_tests.sh`

1. Consider a small scheduled prewarm job only for hot cards:
   - recently scanned cards
   - user collection/watchlist cards
   - top frequently scanned cards
2. Add richer tester-visible freshness labels if testers care about how live a price is.
3. Revisit broader Japanese/custom-numbering support once English/TestFlight signal is strong.

## Pricing Freshness Today

- Persisted SQLite snapshot timestamps are now the source of truth for the `24 hour` freshness window.
- Refresh checks read the stored snapshot first:
  - if the snapshot is fresh, the backend returns it immediately
  - if the snapshot is stale, the backend refreshes the active live provider for that lane and persists the new snapshot
- Manual refresh can bypass the normal freshness gate with `forceRefresh=1`.
- The legacy in-memory provider cache may still exist as an optimization path in shared provider code, but scanner runtime correctness no longer depends on it.
- The app usually shows the stored snapshot immediately, then schedules an idle refresh about `1.8 seconds` after a card is accepted into the tray if the pricing is not already marked fresh.
- User-triggered refresh now goes through the same backend refresh path with `forceRefresh=1`, so it can bypass the normal freshness window.
- App-side offline fallback cache is separate and lasts `7 days`; that is only for showing a previously seen card when the backend is unavailable.

## Pricing Freshness Decision

- Do **not** run a daily cron that refreshes all `15k+` cards. That is wasteful for the current product stage.
- Keep pricing refresh **on-demand**:
  - fast scan/match path reads the latest persisted snapshot from storage
  - if the stored snapshot is older than the target TTL, trigger a provider refresh and persist the new result
  - otherwise return the stored snapshot immediately
- Keep the default freshness window at `24 hours` for now for both raw and slab pricing.
- Add a separate **force refresh** path for explicit user refresh so the user can bypass the 24-hour freshness gate when they really want live data.
- If we add scheduled refreshing later, it should only prewarm a small hot set:
  - recently scanned cards
  - cards in the user collection/watchlist
  - maybe the top N most frequently scanned cards
  not the whole catalog.

## Pricing Freshness Follow-Up TODOs

1. Keep provider/in-memory caching as an optimization, not as the sole source of the 24-hour policy.
2. Add explicit freshness metadata to API responses so the app can show:
   - snapshot age
   - provider updated-at
   - whether the latest response was live-fetched or cache-served
3. Add an ops view/report for pricing freshness:
   - oldest snapshots
   - average snapshot age
   - refresh success/failure rates by provider
4. If Cloud Run remains multi-instance, avoid relying on per-instance memory cache semantics for correctness.
5. Consider a small scheduled prewarm job only after TestFlight proves there is repeated demand for the same cards.

## Immediate next best tasks

1. Verify the new app environment split on device and simulator:
   `Debug` => local, `Staging` => TestFlight/internal, `Release` => production.
2. Verify the real-device scanner fixes for local identifier lookup, safe backend-outage fallback, and Dark Weezing pricing/detail fetch.
3. Re-run the real-world regression set for vintage footer OCR, especially `60/132` cases where the right-side footer can be missed.
4. Add backend catalog coverage or explicit mapping for Japanese / custom-numbering cards that OCR now reads correctly but the backend still treats as unsupported.
5. Configure Scrydex credentials for default PSA testing and keep PriceCharting credentials as fallback coverage.
6. Validate live provider refresh with real credentials.
7. Run regression tests with the new provider architecture.
8. Do human tap-through verification for pricing flows on simulator or device.

## Full execution checklist

Use [raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md) for backend execution guidance and [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current product/runtime state.
