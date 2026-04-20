# PLAN

Date: 2026-04-13

## Current planning override

- The current raw visual-match-primary migration source of truth is [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md).
- The current raw set-badge and Scrydex-first migration source of truth is [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md).
- The current next-step implementation source of truth for improving raw visual retrieval is [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md).
- The earlier OCR-primary backend-reset baseline reference is [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- The current backend latency / network-call refactor pre-implementation source of truth is [docs/backend-latency-refactor-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/backend-latency-refactor-spec-2026-04-10.md).
- The current OCR rewrite / rollout source of truth is [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- The earlier OCR simplification / performance implementation record is [docs/ocr-simplification-performance-implementation-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/ocr-simplification-performance-implementation-spec-2026-04-10.md).
- The low-risk fallback OCR cost-control execution checklist is [docs/fallback-ocr-cost-control-checklist-2026-04-17.md](/Users/stephenchan/Code/spotlight/docs/fallback-ocr-cost-control-checklist-2026-04-17.md).
- The current slab rebuild implementation source of truth is [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md).
- The current inventory / ledger / portfolio source of truth is [docs/inventory-portfolio-selling-spec-2026-04-15.md](/Users/stephenchan/Code/spotlight/docs/inventory-portfolio-selling-spec-2026-04-15.md).
- The planned future collection import source of truth is [docs/collection-import-spec-2026-04-20.md](/Users/stephenchan/Code/spotlight/docs/collection-import-spec-2026-04-20.md).
- The current app design-system scaffold and migration source of truth is [docs/looty-ui-design-system-plan-2026-04-16.md](/Users/stephenchan/Code/spotlight/docs/looty-ui-design-system-plan-2026-04-16.md).
- The raw backend reset has now landed.
- The next raw identity direction is now:
  - visual matching first
  - OCR confirmation second
- The next raw-provider / set-evidence direction is now:
  - set evidence becomes badge-first and typed (`text | icon | unknown`)
  - broad OCR junk such as `p270` must not become trusted set evidence
  - Scrydex becomes the target raw identity/reference/pricing provider lane
- The new scan-artifact + deck-confirmation workstream is now active:
  - scans should persist private source and normalized artifacts
  - scan predictions are not trusted labels
  - `Add to deck` is the confirmation event that turns a scan into a labeled example
  - the deck data model should align with the current add semantics already used by the app
  - the current app-local JSON deck store should remain transitional until the SQL-backed deck flow is in place
  - environment defaults should now be:
    - `Debug` => local backend, deck flow on, scan artifact uploads off by default
    - `Staging` => internal backend, deck flow on, scan artifact uploads on to a private staging bucket
    - `Release` => production backend, deck flow on, scan artifact uploads on-capable behind a backend kill switch and a separate production bucket
- The implementation order for the scan-artifact / deck-confirmation workstream is:
  - schema and doc updates
  - backend artifact upload + deck confirmation endpoints
  - app upload/retry queues and add-confirmation wiring
  - later migration off the local JSON deck store if desired
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
  - identity/pricing core SQLite (`cards`, `card_price_snapshots`, `scan_events`)
  - Scrydex-first for raw identity/reference/pricing
  - PriceCharting preserved as a thin non-active shell
  - legacy raw helper files/tests are deleted; only historical deletion notes remain
- The next scanner-data / moat workstream now adds first-class supporting tables for:
  - scan artifacts
  - scan prediction candidates
  - scan price observations
  - scan confirmations
  - deck entries
- Trusted scan labels should come from explicit `Add to deck`, not from the initial matcher result.
- The next inventory / ledger / portfolio workstream should treat:
  - inventory as the primary current-state model
  - ledger as the append-only record of buys, sells, and adjustments
  - deals as the user-facing transaction records
  - buy / sell / cost basis as the MVP financial vocabulary
  - the portfolio chart as collection-value-only
  - cash / realized profit as separate follow-on metrics, not part of the v1 chart
  - pop report, eBay comps, and a single-square scanner as deferred unless already trivial
- Preserve these states distinctly:
  - `predicted_card_id`
  - `selected_card_id`
  - `confirmed_card_id`
- Current pricing-cache operating decision:
  - the current live beta remains Cloud Run plus on-demand Scrydex with per-instance SQLite caching
  - the same-machine SQLite mirror and nightly full Scrydex sync remain implemented in-repo but are not the live deployment path yet
  - when the mirror path is turned on, nightly full Scrydex sync runs at `3:00 AM America/Los_Angeles`
  - that sync persists card metadata plus raw and graded price snapshots from the same `include=prices` payload
  - fresh successful syncs should suppress normal hot-path Scrydex calls
  - live provider fallback remains available for stale/missing/manual-refresh cases
- Treat the old slab/sync/cache backend modules as deleted legacy state, not as code to revive.
- Treat the current raw OCR rewrite path as the live implementation. Refine it incrementally, but do not reintroduce the deleted salvage-style normalization branch.

## Current inventory / ledger planning override

- The MVP product model is now:
  - inventory = current owned cards
  - ledger = append-only buys, sells, and adjustments
  - deals = user-facing transaction records
  - buy / sell / cost basis = the MVP financial vocabulary
  - portfolio = collection value over time
- The MVP should not be framed around shows as the primary product concept.
- Pop report, eBay comps, and a single-square scanner are deferred unless they are already trivial to surface.
- The first shipping inventory slice should keep:
  - current deck/inventory snapshot reads
  - explicit buy and sell records
  - append-only ledger history
  - collection-value-only portfolio history

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
- Current raw front-half normalization rule:
  - accepted rectangle => perspective-correct + canonicalize
  - weak or ambiguous rectangle => exact reticle fallback
  - no holder salvage or remnant recovery in the active runtime path
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
- Slab OCR is cert-first, not cert-only.
- Certs are OCR-derived lookup keys and repeat-scan cache keys, not an official verification lane.
- Treat live slab runtime as one supported capture path:
  - standard PSA full slab in frame
  - keep the PSA label aligned in the guided top band
- Repeat-scan cert hits should resolve immediately from local scan history when possible.
- First-seen slabs should identify the card from label OCR and then fetch graded pricing from Scrydex.
- Do **not** add PSA API dependencies or “official verification” claims to phase 1.
- Backend slab identity must resolve before pricing and must still succeed when pricing is unavailable.
- Do not add slab visual matching for this phase.
- Cleanup/deletion after slab cutover is mandatory before any non-PSA expansion.
- Non-PSA slabs should return explicit unsupported / needs-review OCR output instead of going through fake generic parsing.
- The current slab rewrite should treat slab OCR as:
  - barcode / cert-first extraction before fallback text identity
  - standard PSA full-slab capture as the supported live path
  - use the in-reticle guide band to keep the PSA label isolated near the top
  - identity decoupled from graded pricing
  - PSA top-label-focused
  - cert / grade / card-number extraction when PSA evidence is strong
  - fixture-first on PSA slab captures
- Future non-PSA slab families should be rebuilt with their own label parsers, not folded back into shared regex heuristics.

### Hardcoded slab logic to remove or downrank

- App slab OCR geometry in [Spotlight/Services/SlabScanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabScanner.swift):
  - one shared `SlabScanConfiguration.LabelOCR` for all graders
  - one shared `SlabScanConfiguration.CardFooterOCR` for all graders
  - one shared `psaLogoRegion` reused even when the slab is not PSA
- App slab label parsing in [Spotlight/Services/SlabLabelParsing.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabLabelParsing.swift):
  - PSA-weighted visual inference scores applied as the main fallback path
  - regex-heavy shared parsing instead of PSA-specific phase-1 parsing
  - shared slab-card-number extraction rules instead of cleaner cert-first PSA parsing
- App slab footer set-hint extraction in [Spotlight/Services/SlabScanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabScanner.swift):
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

### Milestone: Scan artifact dataset + deck-backed confirmation

Status: `planned`

- Goal:
  - build a private scan artifact moat for future training, QA, and price-observation analysis
  - link trusted labels to explicit `Add to deck` actions instead of matcher guesses
- Store per scan:
  - `source_capture`
  - `normalized_target`
  - OCR / request metadata
  - prediction snapshot
  - top candidates
  - prices shown at scan time
- Trust model:
  - scan-time matcher output is prediction only
  - scan-review choice is selection state only
  - `Add to deck` is the trusted confirmation event
- Planned implementation phases:
  - Phase 1:
    - schema and docs updates
    - add deck SQL table to the repo
    - add scan artifact / candidate / confirmation tables
  - Phase 2:
    - backend scan-artifact upload endpoint
    - private object-store / bucket wiring with env-configurable storage
  - Phase 3:
    - backend `Add to deck` endpoint that also writes scan confirmation linkage
    - preserve predicted vs selected vs confirmed card IDs separately
  - Phase 4:
    - app local retry queues for artifact uploads and add confirmations
    - do not block scan UX or add UX on network success
  - Phase 5:
    - optional migration off the current app-local JSON deck store to backend-backed deck reads
  - Phase 6:
    - environment/runtime rollout controls
    - app `Debug` defaults artifact uploads off
    - app `Staging` and `Release` default artifact uploads on
    - backend artifact uploads respect env defaults plus a runtime admin kill switch
    - staging and production use separate private GCS buckets
- Deck identity/dedupe rule:
  - raw entries dedupe by `card_id`
  - slab entries dedupe by `card_id + grader + grade + cert + variant`
- Training/export rule:
  - gold labels come from confirmed add events only
  - selected-without-add rows are weak labels
  - unlabeled scan artifacts remain valuable for OCR/debug/self-supervised work

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

### Milestone 1c: Raw scan reliability and candidate UX hardening

Status: `landed / current state`

Current outcome:

- raw normalization is now simplified to:
  - accepted rectangle => perspective-correct + canonicalize
  - weak/ambiguous rectangle => exact reticle fallback
- frontend fallback scans now support lowered header rescue when footer evidence is strong enough
- backend weak fallback scans now use local-only recall expansion instead of shallow shortlist truncation
- backend scan-match logs now expose Scrydex request and phase timing details for local debugging
- low-signal and weak scans are now treated more honestly, with `needs_review` / alternatives preferred over fabricated cleanup heuristics

What this milestone should no longer re-open by default:

- holder-preserve heuristics
- remnant-aware fallback normalization
- fallback salvage / reconstructed full-card crops
- broad “be clever” normalization retries that can poison `06_ocr_input_normalized.jpg`

Current design rule:

- prefer a simple, honest front half plus backend local recall over aggressive frontend normalization heuristics
- if a scan is weak, prefer:
  - `needs_review`
  - alternatives
  - explicit retake behavior
  over fake geometric recovery

Primary files that now define this landed behavior:

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

Validation focus for future changes in this area:

- backend/unit:
  - `python3 -m unittest -v backend.tests.test_raw_evidence_phase3 backend.tests.test_raw_retrieval_phase4 backend.tests.test_raw_decision_phase5 backend.tests.test_pricing_phase6 backend.tests.test_scan_logging_phase7`
- app/runtime:
  - `zsh tools/run_scanner_reticle_layout_tests.sh`
  - `zsh tools/run_scan_tray_logic_tests.sh`
  - `xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build`
- manual verification:
  - live-device raw scans that previously needed repeat attempts
  - request-budget audit through `GET /api/v1/ops/provider-status`

### Milestone 1d: Shared pricing response layer

Status: `done`

- Raw, visual-only raw, and slab still keep separate evidence extraction, candidate scoring, confidence math, and resolver routing.
- The shared post-match pricing/response layer is now landed in `backend/server.py`:
  - `PricingContext`
  - `PricingLoadPolicy`
  - shared candidate payload builder
  - shared top-candidate encoder
  - shared context-based `card_detail` / refresh plumbing
- Current shared top-candidate pricing policy:
  - raw and slab both return top `5` candidates
  - rank `1` ensures SQLite hydration
  - rank `1` only auto-refreshes missing pricing when the match is `reviewDisposition=ready` and confidence is `high` or `medium`
  - ranks `2-5` return cached pricing only
- Current follow-up still not landed:
  - lazy refresh when the user selects an alternate candidate from the returned top `5`

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
- raw normalization is now simplified to accepted-rectangle perspective correction or exact-reticle fallback
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
  - slab fallback is now intentionally narrow:
    - live slab scans support standard PSA full-slab framing only
    - broad whole-search slab OCR fallback is removed
    - slab fallback now requires either a standard slab crop or an isolated PSA label region
  - `qa/slab-regression/` scaffold is landed
  - current slab regression scaffold contents:
    - tuning fixtures: `28`
    - full slab fixtures: `14`
    - label-only fixtures: `14` derived crops retained for tuning/debug only
    - held-out fixtures: `0` so far
    - excluded from phase 1: `IMG_0162.JPG` because it is `CGC`
  - `zsh tools/run_slab_regression.sh` now validates the slab fixture corpus layout and replays the Apple Vision slab OCR path on simulator
  - current OCR-only slab tuning score on `qa/slab-regression/simulator-vision-v1/scorecard.json`:
    - grader exact: `28/28`
    - grade exact: `28/28`
    - cert exact: `28/28`
    - card number exact: `28/28`
    - this is a tuning-only milestone because the `label_only` half is still derived from the same source photos and is no longer the intended live capture path
- next required sequence is:
  - keep the imported `2026-04-12` PSA photo set as the first tuning corpus
  - tune and harden the standard PSA full-slab entry path
  - keep cert-first backend resolution centered on repeat-scan cert cache plus Scrydex-backed first-seen identity
  - keep identity decoupled from graded pricing
  - re-enable slab backend matching in user-facing runtime only when the rebuilt path is ready
- do not add PSA verification or PSA API integration to this milestone
- do not broaden beyond PSA Pokemon until the held-out suite passes and the cleanup phase is complete

### Milestone 5: Slab cleanup / cutover

Status: `planned`

- remove any remaining transitional slab gating or compatibility branches once the rebuilt path is proven
- refactor or delete obsolete slab logic from `SlabScanner.swift` once `SlabPipeline` is live
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

- Current live beta decision:
  - keep Cloud Run as the active hosted backend for now
  - keep live Scrydex search/refresh behavior active when SQLite is missing or stale
  - keep the nightly same-machine mirror path dormant until it is worth the operational cutover
- Mirror cutover decision, when resumed:
  - run a same-machine nightly Scrydex full-catalog sync at `3:00 AM America/Los_Angeles`
  - require the backend server and the cron job to point at the same SQLite database path
  - do not assume Cloud Run shares that SQLite file
  - nightly sync scope:
    - `cards` metadata mirror
    - raw price snapshot mirror
    - graded price snapshot mirror from the same Scrydex `include=prices` payload
  - once the latest successful full sync is still within the `24 hour` freshness window:
    - serve identity and pricing from SQLite only
    - do not perform normal live Scrydex search or pricing refresh
    - keep live fallback only for stale/failed sync state, missing local data, or explicit force refresh
- Keep the default freshness window at `24 hours`.
- Keep explicit force refresh available even after the nightly sync lands.

## Pricing Freshness Follow-Up TODOs

1. Decide when to cut over from the current Cloud Run live mode to the same-host SQLite mirror mode.
2. Add explicit freshness metadata to API responses so the app can show:
   - snapshot age
   - whether the latest response was served from cached SQLite or a live fallback
3. Add lazy alternate-candidate pricing refresh for user-selected ranks `2-5` on both raw and slab response paths.
4. If the mirror cutover resumes, wire the same-host cron/service setup on the machine that actually owns the SQLite file.
5. Decide later whether to add:
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
