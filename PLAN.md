# PLAN

Date: 2026-04-13

## Current planning override

- The current raw visual-match-primary migration source of truth is [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md).
- The current raw set-badge and Scrydex-first migration source of truth is [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md).
- The current next-step implementation source of truth for improving raw visual retrieval is [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md).
- The current backend reset / raw-matcher redesign source of truth is [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- The current backend latency / network-call refactor pre-implementation source of truth is [docs/backend-latency-refactor-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/backend-latency-refactor-spec-2026-04-10.md).
- The current OCR rewrite / rollout source of truth is [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- The current OCR simplification / performance implementation source of truth for the next OCR pass is [docs/ocr-simplification-performance-implementation-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/ocr-simplification-performance-implementation-spec-2026-04-10.md).
- The current slab rebuild implementation source of truth is [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md).
- The raw backend reset has now landed.
- The next raw identity direction is now:
  - visual matching first
  - OCR confirmation second
- The next raw-provider / set-evidence direction is now:
  - set evidence becomes badge-first and typed (`text | icon | unknown`)
  - broad OCR junk such as `p270` must not become trusted set evidence
  - Scrydex becomes the target raw identity/reference/pricing provider lane
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
  - Scrydex-first for raw identity/reference/pricing
  - PriceCharting preserved as a thin non-active shell
  - Pokemon TCG API raw helper files/tests are deleted; only historical doc references remain
- Current pricing-cache operating decision:
  - move toward a same-machine SQLite mirror for Scrydex-backed metadata/pricing
  - nightly full Scrydex sync runs at `3:00 AM America/Los_Angeles`
  - sync persists card metadata plus raw and graded price snapshots from the same `include=prices` payload
  - fresh successful syncs should suppress normal hot-path Scrydex calls
  - live provider fallback remains available for stale/missing/manual-refresh cases
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
  - run side-by-side with the old path before old OCR is deleted

## Current slab planning override

- The slab rebuild implementation source of truth is now [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md).
- Keep slab/backend runtime deferred until the raw hybrid direction settles, but when slab work resumes the revised implementation order in the slab spec is authoritative.
- Product goal for slabs is identification + graded pricing through Scrydex, not PSA verification.
- Do **not** expand the current slab path with more one-off card-specific fixes unless a blocker absolutely requires a short-lived quarantine rule.
- Do **not** reintroduce the older slab parser-reset direction that front-loads CGC/BGS/TAG support or card-window-relative footer OCR ahead of the PSA cert-first rebuild.
- The active slab OCR path is PSA-only by design.
- Phase 1 slab target is:
  - PSA
  - Pokemon
- Label-only scans are Priority 1, not a polish phase.
- Slab OCR is cert-first, not cert-only.
- Certs are OCR-derived lookup keys and repeat-scan cache keys, not an official verification lane.
- Treat slab runtime as two valid OCR entry paths:
  - full slab
  - label only
- Repeat-scan cert hits should resolve immediately from local scan history when possible.
- First-seen slabs should identify the card from label OCR and then fetch graded pricing from Scrydex.
- Do **not** add PSA API dependencies or “official verification” claims to phase 1.
- Backend slab identity must resolve before pricing and must still succeed when pricing is unavailable.
- Do not add slab visual matching for this phase.
- Cleanup/deletion after slab cutover is mandatory before any non-PSA expansion.
- Non-PSA slabs should return explicit unsupported / needs-review OCR output instead of going through fake generic parsing.
- The current slab rewrite should treat slab OCR as:
  - label-only scans as a first-class path
  - barcode / cert-first extraction before fallback text identity
  - full-slab and label-only OCR entry paths
  - identity decoupled from graded pricing
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
  - regex-heavy shared parsing instead of PSA-specific phase-1 parsing
  - shared slab-card-number extraction rules instead of cleaner cert-first PSA parsing
- App slab footer set-hint extraction in [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift):
  - `knownAlphaOnlyHints` allowlist (`par`, `svi`, `pgo`, `xyp`, `smp`, `mp`, etc.)
  - slab-relative footer rescue rules should become fallback-only once the cert-first PSA path is live
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

- current raw visual/provider cutover state:
  - the held-out Scrydex provider manifest now supports `67/67` fixtures with `0` provider gaps
  - backend badge-image matching is landed for raw set badges
  - backend visual shortlist bias is now landed for raw scans:
    - language-aware reranking
    - `tcgp-*` digital-card de-prioritization
  - stable active visual artifact aliases are now published via:
    - `python3 tools/publish_raw_visual_runtime_artifacts.py --artifact-version <version>`
  - local/staging/production visual env defaults now point at the active aliases, not version-pinned filenames
  - current active alias publication is now `v004-scrydex-b8`
  - active alias held-out/runtime-shaped result on the full `67`-fixture Scrydex-supported suite:
    - visual top-1: `25/67`
    - visual top-5 contains-truth: `37/67`
    - visual top-10 contains-truth: `40/67`
    - hybrid top-1: `36/67`
    - hybrid top-5 contains-truth: `40/67`
  - active Scrydex request-budget guardrails:
    - cached raw scans/details should issue `0` live Scrydex requests
    - during the same-machine nightly-sync stage, first-seen visual-hybrid top-1 hydration should also stay local when the latest full sync is fresh
    - before that sync is fresh, first-seen visual-hybrid top-1 hydration may still issue `1` Scrydex fetch-by-id request
    - before that sync is fresh, non-visual remote raw fallback is capped at `2` Scrydex search queries max
    - `GET /api/v1/ops/provider-status` includes `scrydexRequestStats` for process-local request auditing
  - promoted Scrydex visual candidates:
    - `v004-scrydex` base: hybrid top-1 `29/67`
    - `v004-scrydex-b8` adapter: hybrid top-1 `33/67` before matcher shortlist improvements
    - `v004-scrydex-b8` with matcher shortlist improvements: hybrid top-1 `36/67`
    - runtime decision: keep the active aliases on `v004-scrydex-b8` unless a later Scrydex candidate beats `36/67`
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
- the app scanner runtime now forces backend `rawResolverMode=hybrid`
  - the backend now defaults omitted raw resolver mode to `hybrid`, so raw scans no longer silently fall back to the OCR-primary path
  - end-to-end raw scanner testing now runs:
    - visual retrieval first
    - OCR rerank second
- next work is:
  - improve the visual training signal beyond the first two adapter candidates
  - keep evaluating only on the held-out suite at runtime-shaped `top-K = 10`
  - rebuild the visual index only if a later candidate is actually net-positive
  - keep OCR and runtime `top-K = 10` stable during that phase
  - only after a visual-model win, resume app contract work and cleanup
- landed tooling in that phase now includes:
  - `python3 tools/build_raw_visual_training_manifest.py ...`
  - `python3 tools/mine_raw_visual_hard_negatives.py ...`
  - `.venv-raw-visual-poc/bin/python tools/train_raw_visual_adapter.py ...`
  - `.venv-raw-visual-poc/bin/python tools/eval_raw_visual_model.py ...`
- current measured visual-model results:
  - adapter `v001` held-out result: visual top-10 `32/47`, hybrid top-1 `30/47`
  - hard-negative adapter `v002` held-out result: visual top-10 `33/47`, hybrid top-1 `30/47`
  - smaller-batch hard-negative adapter `v003-b8` held-out/runtime-shaped result:
    - visual top-1: `24/47`
    - visual top-5 contains-truth: `31/47`
    - visual top-10 contains-truth: `37/47`
    - hybrid top-1: `32/47`
    - hybrid top-5 contains-truth: `35/47`
  - current runtime decision:
    - `v003-b8` remains the last PokemonTCG-backed checkpoint
    - `v004-scrydex-b8` plus matcher shortlist improvements is now the active backend visual model through the stable alias artifacts
    - env vars remain available for candidate comparison or rollback
 - the next linked migration slice is now:
   - typed raw set-badge evidence
   - junk set-hint suppression
   - Scrydex-first raw provider migration
   - see [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md)

### Milestone 1c: Raw scan reliability and candidate UX hardening

Status: `planned`

Purpose:

- reduce repeat scans caused by bad raw normalization and weak frontend OCR evidence
- stop wasting live Scrydex pricing fetches on low-confidence guesses
- make weak matches recoverable through candidate selection instead of blind rescans

Execution rules for this slice:

- do not start implementation until the todo list below is reviewed/approved
- keep the held-out raw regression corpus frozen
- for each code change:
  - state the expected improvement first
  - run the relevant regression commands before the change
  - run the same regression commands after the change
  - keep the change only if it is net-positive or neutral
- prefer extending the existing alternatives flow and scan feedback path before adding new endpoints or a separate result-screen architecture

Ordered todo list:

1. Scrydex hot-path gating
   - stop live raw pricing refresh during scan-match response building for `confidence = low` or `reviewDisposition = needs_review`
   - stop idle auto-refresh for review-state tray rows
   - allow live pricing only after:
     - confident auto-accept
     - explicit candidate selection
     - explicit user refresh
   - preserve cached pricing display when available

2. Frontend no-signal retry gate
   - before sending a raw scan to the backend, short-circuit obviously unreadable scans when all of these are true:
     - very low target quality
     - no exact collector
     - no meaningful title
     - no set evidence
   - show a retry/rescan message instead of surfacing a weak backend guess
   - keep this gate aligned with the existing preview-frame-first capture flow

3. Target-selection ambiguity fix
   - in raw mode, when rectangle selection fails because candidates are too close or otherwise ambiguity-driven, evaluate an exact-reticle-direct path before relaxed holder heuristics
   - use a conservative card-likeness check on the reticle crop
   - keep this as an explicit fallback-style path, not as a fake clean primary selection

4. Honest target confidence and fallback reporting
   - make fallback and ambiguity paths report honest `selectionConfidence` / target-quality values
   - fix the current branch where fallback normalization can inherit an unrealistically high confidence from the rejected rectangle candidate
   - preserve clear normalization reasons in artifacts/logs so backend scoring and triage can distinguish:
     - clean rectangle selection
     - relaxed rectangle promotion
     - exact-reticle fallback/direct path
     - holder-preserve rejection

5. Holder-preserve rejection hardening
   - broaden the existing narrow-content rejection so `holder_like_selected_raw_card_preserved` does not survive when the normalized content is too narrow to be a reliable raw-card crop
   - apply the rejection consistently across the relevant raw selection paths, not only the current relaxed branch
   - prefer conservative canonicalization over half-card inner-crop guesses

6. Candidate list contract upgrade
   - return `topCandidates` as top `5` instead of top `3`
   - keep candidate payloads rich enough for the scanner alternatives UX:
     - id
     - name
     - set name
     - number
     - image URLs
     - pricing snapshot if already cached/allowed
     - visual/hybrid scores already exposed in the response

7. Alternatives UX upgrade on top of the existing scanner flow
   - evolve the current [AlternateMatchesView](/Users/stephenchan/Code/spotlight/Spotlight/Views/AlternateMatchesView.swift) instead of introducing a separate architecture first
   - low-confidence / `needs_review` scans should route directly into candidate picking
   - medium/high-confidence scans should keep the main resolved flow but expose a more obvious "similar cards" affordance
   - selecting a candidate should:
     - confirm the card
     - log scan feedback with the selected card id
     - trigger pricing refresh on demand for that chosen card

8. Dedicated result screen decision
   - treat the screenshot-style full card-detail screen as a second-phase UX decision
   - do not block the reliability fixes on building a new standalone result-screen stack
   - only add it after the functional candidate-selection flow is working and reviewed

Primary files expected in this slice:

- `Spotlight/Services/OCR/TargetSelection.swift`
- `Spotlight/Services/OCR/PerspectiveNormalization.swift`
- `Spotlight/Services/OCR/Raw/RawPipeline.swift`
- `Spotlight/ViewModels/ScannerViewModel.swift`
- `Spotlight/Views/AlternateMatchesView.swift`
- `Spotlight/Views/ScannerRootView.swift`
- `Spotlight/Views/ScannerView.swift`
- `backend/server.py`
- `backend/catalog_tools.py`
- `backend/tests/test_raw_decision_phase5.py`
- `backend/tests/test_scan_logging_phase7.py`

Validation focus:

- backend/unit:
  - `python3 -m unittest -v backend.tests.test_raw_evidence_phase3 backend.tests.test_raw_retrieval_phase4 backend.tests.test_raw_decision_phase5 backend.tests.test_pricing_phase6 backend.tests.test_scan_logging_phase7`
- app/runtime:
  - `zsh tools/run_scanner_reticle_layout_tests.sh`
  - `zsh tools/run_scan_tray_logic_tests.sh`
  - `xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build`
- manual verification:
  - live-device raw scans that previously needed repeat attempts
  - request-budget audit through `GET /api/v1/ops/provider-status`

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

Status: `active`

- groundwork already landed:
  - slab match requests now go through the live backend path by default
  - repeat-scan cert cache resolution paths are landed:
    - `psa_cert_barcode`
    - `psa_cert_ocr`
  - slab identity can now succeed without exact graded pricing
  - slab detail / refresh preserves `certNumber`
  - first label-only slab OCR fallback is landed:
    - slab fallback normalization now preserves the search crop as `slab_label`
    - slab OCR can treat that crop as a label-only input instead of pretending it is a full slab
  - `qa/slab-regression/` scaffold is landed
  - current slab regression scaffold contents:
    - tuning fixtures: `28`
    - full slab fixtures: `14`
    - label-only fixtures: `14` derived crops
    - held-out fixtures: `0` so far
    - excluded from phase 1: `IMG_0162.JPG` because it is `CGC`
  - `zsh tools/run_slab_regression.sh` now validates the slab fixture corpus layout and replays the Apple Vision slab OCR path on simulator
  - current OCR-only slab tuning score on `qa/slab-regression/simulator-vision-v1/scorecard.json`:
    - grader exact: `28/28`
    - grade exact: `28/28`
    - cert exact: `28/28`
    - card number exact: `28/28`
    - this is a tuning-only milestone because the `label_only` half is still derived from the same source photos
- next required sequence is:
  - keep the imported `2026-04-12` PSA photo set as the first tuning corpus
  - collect at least `10` real PSA label-only photos for the held-out split
  - tune and harden the experimental full-slab and label-only slab OCR entry paths
  - keep cert-first backend resolution centered on repeat-scan cert cache plus Scrydex-backed first-seen identity
  - keep identity decoupled from graded pricing
  - re-enable slab backend matching in user-facing runtime only when the rebuilt path is ready
- do not add PSA verification or PSA API integration to this milestone
- do not broaden beyond PSA Pokemon until the held-out suite passes and the cleanup phase is complete

### Milestone 5: Slab cleanup / cutover

Status: `planned`

- remove any remaining transitional slab gating or compatibility branches once the rebuilt path is proven
- delete obsolete slab logic from `CardRectangleAnalyzer.swift` once `SlabPipeline` is live
- remove backend slab title-repair heuristics that only compensate for weak OCR
- align docs and ops/provider-status output with actual runtime behavior
- do not begin non-PSA expansion until this cleanup phase is complete

## Remaining tasks

1. Keep [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md) as the raw identity architecture source of truth.
2. Treat [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md) as the next raw implementation source of truth.
3. Treat the first manual-labeled visual-training corpus pass as landed:
  - accepted training fixtures now default to `~/spotlight-datasets/raw-visual-train/`
  - excluded archive defaults to `~/spotlight-datasets/raw-visual-train-excluded/`
  - manual corpus summary now lives under the active training root
  - staged bulk intake now runs through `python3 tools/process_raw_visual_batch.py ...`
  - each batch now writes:
    - `<active-training-root>/batch-audits/<batch-id>/`
    - `<active-training-root>/raw_scan_registry.json`
  - do not import batch photos directly without the four staging buckets:
    - `safe_new`
    - `safe_training_augment`
    - `heldout_blocked`
    - `manual_review`
  - bulk import flow is now `zsh tools/import_raw_visual_train_batch.sh /path/to/images /path/to/cards.tsv`
  - supported manifest headers include `file_name`, `card_name`, `number`, `set promo`
4. Treat the first trainer/tooling pass as landed:
  - shared model layer: `backend/raw_visual_model.py`
  - first trainer: `tools/train_raw_visual_adapter.py`
  - current training command:
    - `.venv-raw-visual-poc/bin/python tools/train_raw_visual_adapter.py --manifest-path ~/spotlight-datasets/raw-visual-train/raw_visual_training_manifest.jsonl --output-dir backend/data/visual-models --artifact-version v001`
5. Rebuild the full visual index only if the new model is net-positive on the held-out suite.
6. Keep runtime `top-K = 10` and current OCR extraction stable until the visual model improves.
7. Do human tap-through verification only after the improved visual model is integrated.
8. Run an explicit deletion/cleanup pass after the improved hybrid path is proven better.
9. Build `qa/slab-regression/` with tuning and held-out PSA fixtures for the cert-first slab rebuild.
10. Implement the label-only slab OCR entry path before any more slab text heuristics.
11. Keep slab cert-first routing focused on repeat-scan cache hits plus Scrydex-backed first-seen identity/pricing.
9. Only then proceed to slab backend/pricing rebuild on top of the settled raw contract:
  - follow the cert-first slab rebuild spec
  - treat label-only handling as Priority 1
  - ship identity-without-pricing as a valid success state
  - complete cleanup before any non-PSA expansion

## Slab cert-first rebuild execution order

1. Build `qa/slab-regression/` with separate tuning and held-out PSA fixtures.
   - Include both:
     - full slab
     - label only
   - Record ground truth for:
     - cert
     - grader
     - grade
     - card identity

2. Measure the current baseline against that suite.
   - Report:
     - cert exact match
     - grader exact match
     - grade exact match
     - card identity exact match
     - end-to-end scan success

3. Split slab OCR into two entry paths.
   - Path A:
     - full slab rectangle detected
     - perspective-correct and normalize the slab
   - Path B:
     - no confident full slab rectangle
     - treat the crop as a valid label-only candidate

4. Make cert extraction dominant in the slab app path.
   - Prefer:
     - barcode-derived cert
     - then OCR-derived cert
     - then fallback text identity
   - Keep text normalization conservative.

5. Add a dedicated backend cert-first resolver.
   - Distinguish:
     - `psa_cert_barcode`
     - `psa_cert_ocr`
     - `psa_label`
   - Keep title/set/card-number search as fallback only.

6. Decouple slab identity from graded pricing.
   - Identity success with `pricing = null` is still success.
   - Exact-grade pricing remains a follow-up serving concern, not the identity gate.

7. Keep slab backend matching on in the app and tune the live path against the held-out suite.
   - Do not keep the current hard-disable path as the shipped steady state.

8. Fix the known slab bugs during cutover.
   - Preserve cert on detail refresh.
   - Stop medium-confidence slab auto-accept.
   - Make provider-status metadata honest.

9. Run held-out regression and tune only on the tuning suite.
   - Do not claim `95%+` from the tuning corpus.

10. Perform the required cleanup/deletion phase before any non-PSA expansion.

## Immediate slab regression fixture plan

1. Collect PSA captures under [qa/slab-regression](/Users/stephenchan/Code/spotlight/qa/slab-regression).
   - Split them into:
     - `tuning`
     - `heldout`
2. Include both:
   - full slab photos
   - label-only photos
3. Add a manifest that records:
   - cert
   - grader
   - grade
   - card identity
   - scan shape
4. Add a dedicated runner:
   - `zsh tools/run_slab_regression.sh`
5. Treat the held-out suite as the source of truth for slab accuracy claims, not ad hoc manual tuning.

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

- Run a same-machine nightly Scrydex full-catalog sync for the current prototype stage.
- Current schedule target:
  - `3:00 AM America/Los_Angeles`
- Current host model:
  - the backend server and the cron job run on the same machine
  - both point at the same SQLite database path
  - do not assume Cloud Run shares that SQLite file
- Nightly sync scope:
  - `cards` metadata mirror
  - raw price snapshot mirror
  - graded price snapshot mirror from the same Scrydex `include=prices` payload
- Scan hot-path serving rule:
  - if the latest successful full sync is still within the `24 hour` freshness window, serve identity and pricing from SQLite only
  - do not perform normal live Scrydex search or pricing refresh in that case
  - keep live fallback only for:
    - stale or failed sync state
    - missing local card data
    - explicit user/admin force refresh
- Keep the default freshness window at `24 hours`.
- Keep explicit force refresh available even after the nightly sync lands.

## Pricing Freshness Follow-Up TODOs

1. Land the dedicated sync runner and same-machine cron wiring:
   - `backend/sync_scrydex_catalog.py`
   - local `crontab` entry at `3:00 AM PT`
   - repo-managed VM deploy path via `backend/deploy.sh vm ...`
2. Persist full Scrydex graded rows, not only one requested grade, into `card_price_snapshots`.
3. Expose latest sync status and freshness in ops/provider-status.
4. Keep Scrydex search identity-only on the hot path.
5. Keep live provider fallback only as a repair path:
   - stale sync
   - missing card
   - force refresh
6. Add explicit freshness metadata to API responses so the app can show:
   - snapshot age
   - whether the latest response was served from a fresh nightly sync or a live fallback
7. Add richer sync ops reporting:
   - latest run status
   - pages fetched
   - raw/graded snapshots written
   - estimated credits used
8. Decide later whether to add:
   - inactive-card pruning
   - image self-hosting/CDN
   - a non-SQLite shared database for multi-host deployment

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
