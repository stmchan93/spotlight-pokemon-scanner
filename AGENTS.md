# AGENTS

Repo-specific workflow notes for future coding agents.

## Scope

- This repo is a local iOS + Python backend prototype for a Pokemon card scanner.
- The active product/status doc is [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md).
- The active raw visual-match migration plan is [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md).
- The active raw set-badge + Scrydex-first migration plan is [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md).
- The active next-step implementation plan for improving raw visual retrieval is [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md).
- The earlier landed backend reset / OCR-primary raw-matcher baseline is [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- The active OCR rewrite / rollout plan is [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- The active slab rebuild / rollout plan is [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md).
- For raw identity backend work, treat the hybrid migration spec as the source of truth over older OCR-primary raw-matcher planning, `direct_lookup`, `slab_sales`, or fragmented SQLite planning notes elsewhere in the repo.
- For raw set evidence and raw provider migration work, treat the set-badge + Scrydex-first spec as the source of truth over older generic `setHints` assumptions or legacy raw-provider assumptions.
- Treat the older raw-backend-reset spec as the source of truth for the currently landed OCR-primary baseline only.
- The revised implementation order in the hybrid migration spec is authoritative:
  - prove visual matching on live normalized images first
  - do not front-load large harness or cleanup work before the proof-of-concept
- After the first hybrid baseline, treat the visual-model-improvement spec as the implementation source of truth for the next raw-card workstream:
  - keep runtime `top-K = 10`
  - keep the held-out regression suite frozen
  - improve the visual model before more OCR tuning
- Current visual-training corpus roots:
  - accepted training fixtures default to `~/spotlight-datasets/raw-visual-train/`
  - labeled-but-excluded archive defaults to `~/spotlight-datasets/raw-visual-train-excluded/`
  - override with `SPOTLIGHT_DATASET_ROOT`, `SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT`, or `SPOTLIGHT_RAW_VISUAL_TRAIN_EXCLUDED_ROOT`
  - treat those roots as config, not hardcoded storage backends; GCS/object storage can be upstream, but tooling should point at a configurable local working root
  - current local workflow/spec: [docs/raw-visual-local-dataset-workflow-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-local-dataset-workflow-2026-04-12.md)
  - preferred bulk batch intake now goes through `python3 tools/process_raw_visual_batch.py ...`, which writes:
    - `<active-training-root>/batch-audits/<batch-id>/`
    - `<active-training-root>/raw_scan_registry.json`
  - do not import new bulk raw photo batches straight into the training root without the staged audit buckets:
    - `safe_new`
    - `safe_training_augment`
    - `heldout_blocked`
    - `manual_review`
  - broken or zero-byte images must stay out of accepted training fixtures and remain in `manual_review`
- For OCR work, treat the OCR rewrite spec as the source of truth over older raw-only OCR heuristics or legacy slab scanner structure.
- For slab OCR/backend work, treat the slab cert-first rebuild spec as the source of truth over older slab parser-reset ideas, generic multi-grader heuristics, or backend slab title-repair notes elsewhere in the repo.
- For raw OCR runtime behavior, treat the normalized-target rewrite path in `Spotlight/Services/OCR/Raw/*`, `TargetSelection.swift`, and `PerspectiveNormalization.swift` as the live source of truth.
- The canonical seed raw regression corpus is [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check).
- The live normalized image produced by the rewrite raw path is the query image source of truth for visual matching experiments, not raw `source_scan.jpg`.
- Current raw set-evidence rule:
  - trusted set evidence must be badge-first
  - broad footer/header OCR text should not be promoted into trusted raw set evidence by default
- The old `RawCardScanner` raw path has been deleted from app runtime. Do not recreate it.

## Audience / ICP guidance

- Treat these as product-default audience heuristics, not universal truths about every user.
- Primary dealer ICP:
  - millennial show vendor / small entrepreneur
  - mid-to-above-average tech savvy, but not looking for enterprise workflow complexity
  - business-minded, negotiation-oriented, fast-moving, and comfortable making pricing decisions live at a table
  - likes polished, high-signal interfaces that feel sharp enough to show off to buyers
  - responds better to Robinhood-style clarity and confidence than Fidelity-style density
  - no need for visible security theater or heavy “trust and compliance” chrome in normal flows
  - values clear totals, fast edits, clean buyer-facing presentation, and lightweight analytics over deep forensic analysis
  - does not need dense card-value-over-time views by default unless they clearly help the active workflow
- Secondary collector ICP:
  - generally `20-40`
  - career professional with disposable income and relatively stable purchasing power
  - average tech savvy
  - socially motivated and comfortable sharing/showing collection wins
  - values analytics, but usually wants concise and actionable metrics rather than deep research dashboards
- Product/UI implication defaults:
  - optimize for speed, clarity, confidence, and social polish
  - prefer bold, legible totals and obvious next actions
  - avoid overbuilding enterprise POS/accounting concepts unless they materially improve the dealer-at-the-table moment
  - prefer summary analytics and financially legible visuals over dense reporting

## Scan Artifact Dataset And Confirmation Rules

- The scanner moat / training dataset now treats scan capture, matcher prediction, scan selection, and deck add confirmation as separate states.
- Store two scan images for artifact capture:
  - `source_capture`
  - `normalized_target`
- `source_capture` should be the real production capture image used by the app at scan time, not a synthetic zoom variant.
- `normalized_target` is the image actually sent through OCR / matcher flow and is required for future model work.
- Scan artifact binaries should live in a private object store / bucket. Do not make scan artifacts public.
- Scan artifact rollout matrix:
  - `Debug` / local dev:
    - deck backend flow stays on
    - scan artifact uploads default `off`
    - if explicitly enabled for local testing, filesystem-backed local storage is acceptable
  - `Staging` / internal dogfood:
    - deck backend flow stays on
    - scan artifact uploads should be `on`
    - artifact storage should be private GCS
  - `Release` / production:
    - deck backend flow stays on
    - scan artifact uploads may be `on`, but must stay behind a backend runtime kill switch
    - production artifacts must use a different private GCS bucket than staging
- Scan artifact runtime controls:
  - app build-config gate: `SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED`
  - backend env default gate: `SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED`
  - backend runtime override: `POST /api/v1/admin/scan-artifact-uploads`
  - backend storage selector: `SPOTLIGHT_SCAN_ARTIFACTS_STORAGE`
  - backend private bucket: `SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET`
- Matcher output is not ground truth:
  - `predicted_card_id` = backend top guess at scan time
  - `selected_card_id` = card chosen during scan review flow
  - `confirmed_card_id` = trusted label only after explicit `Add to deck`
- Do not collapse or overwrite those three card-id states into one field.
- `Add to deck` is the trusted confirmation event for labeled training data.
- Keep scan selection feedback separate from deck confirmation:
  - scan feedback may update `selected_card_id`
  - only add-to-deck may update `confirmed_card_id`
- Training/export guidance:
  - use `confirmed_card_id` rows as gold labels
  - treat `selected_card_id` without add confirmation as weak labels only
  - keep unlabeled artifact rows for OCR/debug/self-supervised analysis
- Deck / collection dedupe semantics must match current app behavior:
  - raw cards dedupe by `card_id`
  - slabs dedupe by `card_id + grader + grade + cert + variant`
- The backend schema is no longer only the original identity/pricing trio in practice.
  - `cards`, `card_price_snapshots`, and `scan_events` remain the core identity/pricing spine
  - scan artifact, candidate, price-observation, confirmation, and deck tables are now first-class supporting tables

## Current raw scan reliability state

- The recent raw reliability hardening work is mostly landed.
- Active raw front-half rule:
  - accepted rectangle => perspective-correct + canonicalize
  - weak or ambiguous rectangle => exact reticle fallback
- Do not reintroduce holder salvage, remnant recovery, or inner-card reconstruction as default raw runtime behavior without fresh regression evidence.
- Exact-reticle fallback scans may still use:
  - lowered header rescue on the frontend
  - wider local-only candidate recall / alternate local visual query variants on the backend
- Preferred product behavior remains:
  - centered or slightly zoomed-out raw scans should work
  - weak/ambiguous scans should prefer `needs_review`, alternatives, or explicit retake behavior over fake cleanup heuristics
- If you revisit this area, start from the current runtime code in:
  - `Spotlight/Services/OCR/TargetSelection.swift`
  - `Spotlight/Services/OCR/PerspectiveNormalization.swift`
  - `Spotlight/Services/OCR/Raw/RawPipeline.swift`
  - `backend/server.py`
  - `backend/catalog_tools.py`

## Subagent workflow

- Keep the workflow lightweight. This repo is one SwiftUI iOS app plus one Python backend, so most tasks should use one agent or a short `architect -> implementer -> QA` chain, not a large agent swarm.
- Shared starting points for every agent:
  - read this file first
  - read [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for current product/runtime rules
  - read [PLAN.md](/Users/stephenchan/Code/spotlight/PLAN.md) when milestone/status context matters
  - then read only the code and docs for the touched area
- Repo map for agent scoping:
  - iOS composition/env: `Spotlight/App`, `Spotlight/Config`
  - iOS UI: `Spotlight/Views`
  - iOS scanner orchestration/state: `Spotlight/ViewModels`
  - iOS parsing/network/cache helpers: `Spotlight/Services`
  - shared app models/tray logic/API models: `Spotlight/Models`
  - backend HTTP/runtime entrypoint: `backend/server.py`
  - backend matching, SQLite, shared resolver helpers: `backend/catalog_tools.py`
  - backend provider adapters/contracts: `backend/pricing_provider.py`, `backend/*adapter.py`
  - validation/manifests/manual QA: `tools/`, `qa/`, `backend/tests/`, `Spotlight/Tests/`
- Required handoff artifact between agents: keep it short and structured.
  - `Scope:` request summary and exact surface
  - `Files:` likely or actual touched files only
  - `Acceptance:` concrete success conditions
  - `Validation:` exact commands run or still needed
  - `Risks:` edge cases, blockers, or `none`
- Routing:
  - `Implementer only`:
    - doc-only updates
    - single-view copy/layout tweaks
    - isolated parser/test/helper changes with obvious scope
    - narrow backend fixes with clear root cause and limited file spread
  - `Architect -> Implementer`:
    - medium ambiguity
    - multi-file work inside one app/backend surface
    - scanner state flow updates
    - endpoint/model additions
    - Xcode/backend config changes
  - `Architect -> Implementer -> QA`:
    - resolver/router logic
    - OCR/parser behavior
    - pricing freshness/provider selection
    - raw/slab mode routing
    - backend schema or API contract changes
    - user-facing scanner tray behavior that can silently misidentify or misprice cards
  - `Investigation first`:
    - if the root cause is unclear, use Architect or Implementer to localize the issue before coding
    - add QA once the fix scope is known or the change crosses app/backend boundaries
- Role files live here:
  - [.agents/architect.md](/Users/stephenchan/Code/spotlight/.agents/architect.md)
  - [.agents/implementer.md](/Users/stephenchan/Code/spotlight/.agents/implementer.md)
  - [.agents/qa.md](/Users/stephenchan/Code/spotlight/.agents/qa.md)

## Current provider rules

- Pricing provider abstraction is now implemented with specialized providers.
- Runtime status:
  - raw remains the more mature lane during the reset
  - slab is live for PSA Pokemon testing through the cert-first rebuild path
- Runtime scanner behavior is mode-specific, not cross-provider blended:
  - **Raw mode**:
    - resolve as `raw_card`
    - send OCR payloads directly to the backend matcher
    - treat Scrydex as the active raw identity/reference/pricing provider lane
    - if runtime/code still depends on older raw-provider assumptions, treat that as transitional deletion debt rather than the desired architecture
  - **Slab mode**:
    - send OCR payloads directly to the backend matcher
    - use the cert-first slab spec instead of reviving the old heuristic slab matcher
    - treat the current slab lane as PSA Pokemon only while held-out validation is still in progress
- PriceCharting remains a thin provider shell for env/config structure and later work, but it is not an active runtime lane right now.
- Scrydex is the active raw identity/reference/pricing lane and the intended slab identity/pricing lane.
- Do not add a PSA API or “official verification” dependency to the slab rebuild.
- Treat slab certs as OCR-derived lookup keys and repeat-scan cache keys, not as an official PSA-validation contract.
- Each provider implements the shared `PricingProvider` contract.
- Provider prices are **not** blended or averaged together.
- The tray shows one active/default provider result.
- The architecture supports future side-by-side provider display in detail views.
- Current SQLite runtime shape:
  - the core card/runtime cache still centers on `cards`, `card_price_snapshots`, and `scan_events`
  - the scan-artifact / deck-confirmation work adds additional tables for artifacts, predictions, confirmations, and deck entries
  - do not describe the runtime as "only 3 tables" once the scan-artifact dataset lands
- Pricing freshness rule:
  - persisted SQLite snapshot timestamps are the source of truth for the normal cached freshness window and for `isFresh`
  - live pricing is a separate explicit runtime gate, not the same thing as normal cached freshness
  - when live pricing is `off`, scanner/runtime pricing reads must stay SQLite-only everywhere and must not issue hidden provider refreshes
  - when live pricing is `on`, scanner/runtime metadata still comes from SQLite, but pricing may refresh live
  - the live-pricing refresh window is `1 hour` and applies only when live pricing is enabled
  - when live pricing is `on`, scan responses may reuse SQLite pricing that was refreshed within the last hour; otherwise they should refresh pricing live and persist it back to SQLite
  - `forceRefresh` may bypass the normal freshness gate only when live pricing is enabled; it must not punch through the live-pricing-off SQLite-only rule
  - the in-memory provider cache may exist as an optimization, but it is not the correctness layer for scanner runtime behavior
- Shared pricing/response layer rule:
  - keep raw/slab evidence extraction, candidate scoring, confidence math, and resolver routing separate
  - after identity resolution, raw and slab should share the same pricing/context plumbing
  - the shared backend layer now centers on:
    - `PricingContext`
    - `PricingLoadPolicy`
    - one shared candidate payload builder
    - one shared top-candidate encoder
    - one shared context-based refresh/detail path
  - do not reintroduce separate `_raw_candidate_payload` / `_slab_candidate_payload` style forks unless there is a real behavior divergence that the shared layer cannot express cleanly
- Shared top-candidate pricing policy:
  - raw and slab both return top `10` candidates
  - candidate metadata always comes from SQLite
  - when live pricing is `off`, ranks `1-10` return SQLite pricing only with no live refreshes
  - when live pricing is `on`, the matched card plus ranks `1-10` may refresh pricing live when the stored snapshot is missing or older than `1 hour`, then persist the refreshed pricing back to SQLite
  - there is no rank-1 special case in the live-pricing path

- Current Scrydex mirror rule:
  - the current beta deployment is a same-host VM plus nightly Scrydex mirror against one shared SQLite file
  - run the backend and the nightly Scrydex sync on the same machine against the same SQLite file
  - nightly full-catalog sync runs at `3:00 AM America/Los_Angeles`
  - sync command:
    - `python3 backend/sync_scrydex_catalog.py --database-path backend/data/spotlight_scanner.sqlite`
  - sync should persist:
    - card metadata
    - raw price snapshots
    - graded price snapshots returned by the same `include=prices` payload
  - when live pricing is `off`, treat that nightly mirror as authoritative and keep normal scan hot paths SQLite-only even if snapshots are older than the live-pricing `1 hour` window
  - live pricing is an explicit opt-in runtime mode, not a silent fallback when the mirror is stale
      - a card is unexpectedly missing locally
      - the caller explicitly forces refresh
- Scrydex request-budget rule:
  - cached raw scans/details should stay fully local and issue `0` live Scrydex requests
  - once the nightly full sync is fresh, first-seen raw and slab responses should also stay local unless an explicit fallback condition is hit
  - before the nightly sync is in place or when it is stale, non-visual remote raw fallback is capped at `2` Scrydex search requests max
  - use `GET /api/v1/ops/provider-status` and inspect `scrydexRequestStats` when auditing overage risk
- Implementation files:
  - [backend/pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py) - provider contract and registry
  - [backend/pricing_utils.py](/Users/stephenchan/Code/spotlight/backend/pricing_utils.py) - shared price normalization utilities
  - [backend/pricecharting_adapter.py](/Users/stephenchan/Code/spotlight/backend/pricecharting_adapter.py) - PriceCharting implementation
  - [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py) - Scrydex implementation
  - scan artifact / confirmation / deck storage should be implemented alongside:
    - `backend/server.py`
    - `backend/catalog_tools.py`
    - `backend/schema.sql`

## Backend Reset Direction

- The raw backend reset is active and intentionally replaced the old collector-number-first matcher:
  - old `direct_lookup`-first raw routing is removed from the active raw runtime path
  - runtime raw matching now uses evidence extraction -> title/broad retrieval -> footer rerank
- runtime SQLite identity/pricing core remains:
  - `cards`
  - `card_price_snapshots`
  - `scan_events`
- scan dataset / confirmation support now layers on top of that core with:
  - scan artifact storage
  - scan candidate snapshots
  - scan price observations
  - scan confirmations
  - deck entries
- Current landed raw matcher baseline:
  - title/header and broader text retrieve candidates first
  - footer OCR confirms, reranks, and breaks ties later
  - backend always returns a best candidate, even at low confidence
- Next raw redesign target:
  - visual matching retrieves candidates first
  - OCR confirms, reranks, and breaks ties later
  - backend returns a best candidate plus alternatives
- Phase ordering for raw migration:
  - Phase 0: local proof-of-concept on live normalized images and provider-supported mappings
  - Phase 1: full reference index buildout
  - Phase 2: visual-only backend retrieval
  - Phase 3: lightweight OCR-vs-visual scorecard
  - Phase 4: hybrid resolver
  - Phase 5: app contract update
  - Phase 6: expanded harness and tuning
  - Phase 7: deletion and cleanup
- Current compatibility note:
  - raw responses still surface `resolverPath = visual_fallback` to avoid breaking the current Swift enum/client contract
  - the underlying raw matcher is no longer the old visual/direct-lookup path
- Do not add new OCR-primary raw matcher branches as if they are the long-term destination.
- Do not do a large standalone backend refactor before Phase 0 proves the visual approach.
- Extract cleaner module seams while implementing the visual matcher, not as a prerequisite phase.
- Prefer extracting raw identity logic into cleaner module seams instead of growing `backend/catalog_tools.py` indefinitely.
- Current local visual tooling:
  - `zsh tools/run_raw_visual_poc.sh`
  - `zsh tools/run_build_raw_visual_index.sh`
- Current raw visual runtime state:
  - the held-out Scrydex provider manifest now supports `67/67` fixtures with `0` provider gaps
  - the backend now supports badge-image matching in:
    - `backend/raw_set_badge_matcher.py`
    - `backend/catalog_tools.py`
    - `backend/server.py`
  - the visual matcher now applies:
    - language-aware shortlist reranking
    - `tcgp-*` de-prioritization for raw physical scans
    - wider internal retrieval before final `top-K = 10`
  - stable active visual artifact aliases now exist:
    - `backend/data/visual-index/visual_index_active_clip-vit-base-patch32.npz`
    - `backend/data/visual-index/visual_index_active_manifest.json`
    - `backend/data/visual-models/raw_visual_adapter_active.pt`
    - `backend/data/visual-models/raw_visual_adapter_active_metadata.json`
  - the active aliases are currently published from `v004-scrydex-b8`
  - current active-alias held-out/runtime-shaped result on the full `67`-fixture Scrydex-supported suite:
    - visual top-1: `25/67`
    - visual top-5 contains-truth: `37/67`
    - visual top-10 contains-truth: `40/67`
    - hybrid top-1: `36/67`
    - hybrid top-5 contains-truth: `40/67`
  - Scrydex request-budget guardrails now landed:
    - cached raw scans/details should issue `0` live Scrydex requests
    - during the same-machine nightly-sync stage, first-seen visual-hybrid top-1 hydration should also stay local when the latest full sync is fresh
    - before that sync is fresh, first-seen visual-hybrid top-1 hydration may still issue `1` Scrydex fetch-by-id request
    - before that sync is fresh, non-visual remote raw fallback is capped at `2` Scrydex search queries max
    - `GET /api/v1/ops/provider-status` includes `scrydexRequestStats`
  - promoted Scrydex visual candidates:
    - base `v004-scrydex`: hybrid top-1 `29/67`
    - adapter `v004-scrydex-b8`: hybrid top-1 `33/67` before matcher shortlist improvements
    - adapter `v004-scrydex-b8` with language-aware shortlist improvements: hybrid top-1 `36/67`
    - runtime decision: keep the active aliases on `v004-scrydex-b8` unless a later candidate beats `36/67`
- Current local Phase 0 proof:
  - provider-supported fixtures: `47`
  - visual top-1: `39/47`
  - visual top-5 contains-truth: `41/47`
- Current local Phase 1 full-index baseline:
  - retained catalog cards: `20,237`
  - embedded entries: `20,182`
  - skipped entries: `55`
  - full-index visual top-1: `22/47`
  - full-index visual top-5 contains-truth: `28/47`
- Current local visual shortlist ceiling:
  - full-index visual top-10 contains-truth: `32/47`
- Current local larger-K ceiling sweep:
  - top-20 contains-truth: `35/47`
  - top-30 contains-truth: `35/47`
  - top-50 contains-truth: `35/47`
  - runtime decision: do not widen beyond `top-K = 10`
- Current local artwork-only crop result:
  - top-1: `15/47`
  - top-5 contains-truth: `26/47`
- Current local hybrid reranker result:
  - honest post-harness-fix hybrid baseline: `28/47`
  - current hybrid top-1 after leader protection + fuzzy-set dampening: `30/47`
  - current hybrid top-5 contains-truth: `31/47`
- The next implementation phase is:
  - build a separate raw visual training corpus
  - train a lightweight adapter on top of frozen CLIP
  - rebuild the visual index only if the held-out suite improves
- Landed tooling in that phase now includes:
  - `python3 tools/process_raw_visual_batch.py --spreadsheet ... --photo-root ...`
  - `zsh tools/import_raw_visual_train_batch.sh /path/to/images /path/to/cards.tsv`
  - `python3 tools/build_raw_visual_training_manifest.py ...`
  - `python3 tools/mine_raw_visual_hard_negatives.py ...`
  - `.venv-raw-visual-poc/bin/python tools/train_raw_visual_adapter.py ...`
  - `.venv-raw-visual-poc/bin/python tools/eval_raw_visual_model.py ...`
- Manual-label corpus prep is now also landed:
  - `python3 tools/apply_raw_visual_train_manual_labels.py`
  - current accepted training manifest summary lives under the active training root, default `~/spotlight-datasets/raw-visual-train/raw_visual_training_manifest_summary.json`
- First visual-model training tooling is now also landed:
  - shared model layer: `backend/raw_visual_model.py`
  - first trainer: `tools/train_raw_visual_adapter.py`
  - current training command:
    - `.venv-raw-visual-poc/bin/python tools/train_raw_visual_adapter.py --manifest-path ~/spotlight-datasets/raw-visual-train/raw_visual_training_manifest.jsonl --output-dir backend/data/visual-models --artifact-version v001`
- Current visual-model candidate results:
  - adapter `v001` held-out result:
    - visual top-1: `22/47`
    - visual top-10 contains-truth: `32/47`
    - hybrid top-1: `30/47`
  - hard-negative adapter `v002` held-out result:
    - visual top-1: `22/47`
    - visual top-10 contains-truth: `33/47`
    - hybrid top-1: `30/47`
  - smaller-batch hard-negative adapter `v003-b8` held-out/runtime-shaped result:
    - visual top-1: `24/47`
    - visual top-5 contains-truth: `31/47`
    - visual top-10 contains-truth: `37/47`
    - hybrid top-1: `32/47`
    - hybrid top-5 contains-truth: `35/47`
  - runtime decision:
    - `v003-b8` remains the last PokemonTCG-backed checkpoint, but it is no longer the active publication
    - `v004-scrydex-b8` plus matcher shortlist bias is the active runtime publication through the stable alias artifacts
    - env vars remain explicit override points:
      - `SPOTLIGHT_VISUAL_INDEX_NPZ_PATH=backend/data/visual-index/visual_index_active_clip-vit-base-patch32.npz`
      - `SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH=backend/data/visual-index/visual_index_active_manifest.json`
      - `SPOTLIGHT_VISUAL_ADAPTER_CHECKPOINT_PATH=backend/data/visual-models/raw_visual_adapter_active.pt`
      - `SPOTLIGHT_VISUAL_ADAPTER_METADATA_PATH=backend/data/visual-models/raw_visual_adapter_active_metadata.json`
- Treat that Phase 0 result as the current go/no-go evidence for continuing the hybrid migration.
- Treat the Phase 1 full-index result as the first real production-shaped visual-only baseline.
- Treat the current hybrid reranker result as the first material evidence that OCR should be used as a reranker over the visual shortlist, not as the raw-primary identifier.
- Treat the visual-model-improvement spec as the next raw implementation contract and do not improvise new OCR-heavy follow-up phases on top of this baseline.
- Provider target after reset:
  - raw identity/reference/pricing => Scrydex-first lane
  - slab identity/pricing => Scrydex lane
- Keep the app/backend split:
  - app = capture, normalize, OCR, structured hints, normalized image upload
  - backend = visual retrieval, OCR rerank, identity resolution, pricing refresh, scan logging
- The full migration plan for that direction lives in [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md).

## OCR Rewrite Direction

- The next scanner rewrite is a full OCR rewrite with:
  - a shared front half
  - a raw branch
  - a slab branch
- Top-level OCR routing should follow the UI-selected scan mode:
  - `raw`
  - `slab`
- Do not introduce a third top-level `rawInHolder` mode.
  - holder / sleeve / top-loader cases stay inside the raw branch as scene traits
- Shared front half responsibilities:
  - frame source selection
  - reticle-guided target selection
  - perspective normalization
  - mode sanity signals
- After normalization, OCR must branch:
  - raw OCR extracts evidence for backend matching
  - slab OCR extracts cert-first card-identity evidence plus grader / grade / fallback title-set-card-number fields
- Slab OCR in phase 1 is cert-first, not cert-only:
  - cert is the primary slab key when barcode or OCR cert extraction is strong
  - slab still needs:
    - title / name
    - set
    - card number
    as fallback identity evidence
  - grader + grade remain explicit for display context and pricing selection
  - live slab capture is standard PSA full-slab only, with a guided top label band inside the reticle
  - do not broaden slab OCR back into full-search salvage as a normal runtime path
  - phase 1 slab runtime target is PSA Pokemon only
- Do not add raw-style visual matching for slabs.
- OCR and backend confidence are separate:
  - OCR confidence = field extraction confidence from the image
  - backend confidence = card-match confidence from the evidence
- Do not collapse OCR confidence and backend match confidence into one score.
- The reticle is a target-selection hint, not the exact OCR crop.
- Raw runtime now goes through the rewrite path directly.
- Do not add new raw OCR behavior into [Spotlight/Services/SlabScanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabScanner.swift).
- Keep slab runtime logic isolated from the raw OCR path.
- The full OCR architecture, fixture set, replay/debug requirements, and phase-by-phase rollout live in [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).

### Current raw OCR source of truth

- Raw runtime OCR path:
  - preview-frame-first capture
  - reticle-expanded search crop
  - target selection from rectangle candidates
  - accepted rectangle => perspective-correct + canonicalize
  - weak or ambiguous rectangle => exact reticle fallback
  - deterministic normalized target crop
  - raw stage 1 footer ROIs:
    - footer band
    - footer left metadata strip
    - footer right metadata strip
  - raw stage 2 header fallback only when stage 1 is weak
- Raw OCR should now be treated as backend evidence and hybrid-rerank support, not the long-term sole raw identity engine.
- Before suggesting OCR parameter, ROI, parser, or preprocessing changes, ask:
  - `Do we have regression suite results for this change?`
- Primary implementation files:
  - [Spotlight/Services/OCR/TargetSelection.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/TargetSelection.swift)
  - [Spotlight/Services/OCR/PerspectiveNormalization.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/PerspectiveNormalization.swift)
  - [Spotlight/Services/OCR/Raw/RawPipeline.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawPipeline.swift)
  - [Spotlight/Services/OCR/Raw/RawROIPlanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawROIPlanner.swift)
  - [Spotlight/Services/OCR/Raw/RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)
  - [Spotlight/Services/OCR/Raw/RawEvidenceSynthesizer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawEvidenceSynthesizer.swift)
- Debug artifact naming for the shared front half:
  - `01_full_camera_frame.jpg`
  - `02_reticle_expanded_search_crop.jpg`
  - `04_selected_target_crop.jpg`
  - `05_rectangle_candidate_overlay.jpg`
  - `06_ocr_input_normalized.jpg`
- Raw footer ROI artifacts:
  - `13_raw_footer_band.jpg`
  - collector ROI artifacts remain the most useful image-level footer diagnostics
  - set-badge ROI crops and aggressive retry crops are omitted from default debug exports
  - when footer routing recenters collector ROIs around a band-derived anchor, the ROI labels now include `_anchored` so they no longer imply a literal left/right crop

## Local backend and catalog rules

- During local development and scanner debugging, the app should target a **local backend**, not a production cloud URL.
- App environment selection should be driven by Xcode config files, not ad hoc hardcoded URLs in Swift:
  - `Debug` => local backend
  - `Staging` => TestFlight / internal backend
  - `Release` => production backend
- The machine-local override file is `Spotlight/Config/LocalOverrides.xcconfig`.
- Current default staging host is `https://spotlight-backend-grhsfspaia-uc.a.run.app/`.
- Current production host is also `https://spotlight-backend-grhsfspaia-uc.a.run.app/`.
- Default local backend assumptions:
  - simulator: `http://127.0.0.1:8788/`
  - physical device: set `SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL` in `LocalOverrides.xcconfig` to the Mac's LAN URL, for example `http://192.168.x.y:8788/`
- `SPOTLIGHT_API_BASE_URL` is still allowed as an emergency runtime override, but it should not be the primary day-to-day environment switch.
- Do **not** re-introduce a baked-in production cloud backend URL as the default app target for development/testing.
- Do not re-introduce a checked-in backend Pokémon catalog JSON snapshot as a runtime source of truth.
- Canonical scanner runtime architecture:
  - treat the app as OCR capture plus backend request/response UI, not as a local card-identity runtime
  - treat backend SQLite as the runtime cache/source for previously hydrated card metadata and pricing snapshots
  - treat provider APIs as the live source of truth for rich metadata and pricing:
    - raw/singles => Scrydex-first migration lane
    - slab/graded => Scrydex
  - do not make Cloud Run correctness depend on a preseeded lightweight JSON catalog file or bundled local identifier asset
- Current deployment rule for the SQLite mirror stage:
  - if you want the nightly Scrydex mirror to be authoritative, the backend process and the cron job must run on the same host with the same SQLite database path
  - do not assume Cloud Run instances share the same local SQLite file as a cron job running elsewhere
  - for internet-reachable tester builds, point the app at the host that is actually running that shared backend + cron pair
  - current live hosted beta path is the same-host VM mirror setup, not Cloud Run
- Preferred raw runtime flow:
  - app OCR extracts collector number/text locally
  - app sends the normalized image plus OCR payload to the backend
  - the backend visually retrieves candidates, reranks with OCR evidence, and hydrates SQLite on demand
  - backend SQLite is a runtime cache for imported card metadata/pricing, not a required preseeded catalog
  - Cloud Run should not depend on a seeded local JSON catalog file to recognize standard raw cards
- Canonical raw scan flow:
  - 1. app normalizes the card image and runs OCR
  - 2. app sends the normalized image plus OCR evidence to the backend
  - 3. backend visually retrieves top raw candidates
  - 4. backend reranks and confirms with OCR evidence
  - 5. backend reads the matched card plus top candidates from SQLite for metadata and pricing
  - 6. when live pricing is `off`, backend returns SQLite pricing as-is and must not issue live provider calls
  - 7. when live pricing is `on`, backend may refresh pricing for the matched card plus top candidates if the stored pricing is missing or older than `1 hour`
  - 8. backend persists any live-refreshed pricing back into SQLite before returning the response
  - 9. `isFresh` remains the normal persisted-snapshot freshness concept used by the nightly mirror path; it is not the same as the live-pricing `1 hour` eligibility window
  - 10. metadata remains SQLite-backed even when live pricing is enabled
- Required raw migration cleanup rule:
  - after the hybrid path is proven and cut over, schedule an explicit cleanup pass to remove dead OCR-primary resolver code, misleading compatibility names, obsolete tests, and stale docs before starting major new raw feature work
- Required slab rebuild cleanup rule:
  - after the cert-first slab path is proven on the held-out suite, schedule an explicit cleanup pass to remove obsolete slab heuristics, misleading ops metadata, stale tests, and stale docs before starting non-PSA slab work
- Canonical slab scan flow:
  - app runtime sends slab scans through the backend by default
  - use [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md) as the slab source of truth
  - phase 1 slab target is:
    - PSA
    - Pokemon
    - full slab photos
    - label-only photos
  - the required slab rebuild order is:
    - build `qa/slab-regression/` tuning and held-out fixtures
    - split slab OCR into full-slab and label-only entry paths
    - make cert resolution dominant: barcode -> OCR -> repeat-scan cert cache -> label-text fallback
    - resolve first-seen slab identity/pricing through Scrydex once the card is known
    - let identity succeed with `pricing = null`
    - do not add PSA API verification calls or claims
    - finish cleanup/deletion before non-PSA expansion
  - current imported tuning corpus from `~/Downloads/drive-download-20260412T181003Z-3-001` is:
    - `14` real PSA full-slab photos
    - `14` derived label-only crops from those same photos
    - excluded: `IMG_0162.JPG` because it is `CGC`, not `PSA`
  - do not treat the derived label-only crops as held-out evidence
  - before claiming slab accuracy or cutting over runtime, collect at least `10` real PSA label-only photos and place them in the held-out split
  - do not rebuild slab behavior on top of deleted legacy slab modules
  - rebuild slabs later using the preserved thin Scrydex adapter and the 3-table SQLite model
- Freshness policy:
  - `updated_at` / persisted snapshot timestamps in SQLite are the correctness layer for the normal cached freshness model
  - `isFresh` should reflect that normal persisted-snapshot freshness model, not the live-pricing `1 hour` refresh window
  - the live-pricing `1 hour` refresh window should only be consulted when live pricing is enabled
  - in-memory caches are allowed only as short-lived optimizations and must not decide correctness
  - `forceRefresh` should bypass the normal freshness gate and re-query the live provider only when live pricing is enabled
- Rich card metadata and pricing should come from runtime metadata/provider APIs:
  - raw/singles => Scrydex-first migration lane
  - slab/graded => Scrydex
  - do not silently cross-fallback slab pricing into raw pricing in the scanner flow
  not from large checked-in image bundles.
- Do not use card-ID prefix hacks such as `me*` blocking in runtime matching or bundled identifier lookup.
- Do not re-introduce bundled/local raw identifier maps or client-side candidate hydration hints for raw scans.
- `backend/catalog/` has been deleted from the active backend. Do not reintroduce bundled catalog/image/sample artifacts as runtime dependencies.
- If current backend code still references local reference images for visual retrieval, call that out as legacy technical debt instead of expanding that pattern.
- Scanner presentation rule:
  - preserve the current capture UX unless there is a concrete bug:
    - tap-to-scan
    - preview-frame-first capture
    - raw/slab reticle behavior
    - immediate pending tray row
  - tap-to-scan should use the current preview frame path first, not a new high-latency still-photo capture, unless preview-frame capture is unavailable and a fallback is required
  - the scan tray should show a pending row immediately on tap; do not reintroduce UX that waits for image capture to finish before the tray updates
  - treat raw-vs-slab reticle sizing as a UI/layout concern first, not a reason to casually retune raw OCR
  - raw mode should use a standard card-style reticle
  - slab mode should use the full standard-PSA slab reticle with an internal divider showing label vs card regions
  - slab mode should assume a standard PSA slab is fully inside the reticle and the label sits above the guide
  - if the scanner cannot isolate the PSA slab or its label region, fail fast with guidance instead of OCRing the whole crop
  - keep comfortable spacing above the reticle, between the reticle and controls, and between the controls and tray
  - the raw/slab toggle is a real routing signal, not presentation-only:
    - raw => raw OCR branch + raw backend flow
    - slab => slab OCR branch + future slab backend flow
  - current backend runtime is still raw-only, so slab scans should remain clearly unsupported until the slab backend is rebuilt
  - do not silently degrade slab scans into raw matches or raw price proxies

## Key backend entry points

- `backend/server.py`
- `backend/catalog_tools.py`
- `backend/pricing_provider.py`
- `backend/scrydex_adapter.py`
- `backend/pricecharting_adapter.py`
- `backend/validate_scrydex.py`

## Key app entry points

- `Spotlight/ViewModels/ScannerViewModel.swift`
- `Spotlight/Views/ScannerView.swift`
- `Spotlight/Models/CardCandidate.swift`
- `Spotlight/Models/ScanModels.swift`
- `Spotlight/Models/ScanTrayLogic.swift`

## Validation commands

Run these after backend or app changes:

```bash
python3 -m py_compile backend/catalog_tools.py backend/raw_set_badge_matcher.py backend/pricecharting_adapter.py backend/pricing_provider.py backend/pricing_utils.py backend/scrydex_adapter.py backend/sync_scrydex_catalog.py backend/validate_scrydex.py backend/server.py
python3 -m unittest -v backend.tests.test_backend_reset_phase1 backend.tests.test_raw_evidence_phase3 backend.tests.test_raw_retrieval_phase4 backend.tests.test_raw_decision_phase5 backend.tests.test_pricing_phase6 backend.tests.test_scan_logging_phase7 backend.tests.test_pricing_utils
zsh tools/run_card_identifier_parser_tests.sh
zsh tools/run_raw_card_decision_tests.sh
zsh tools/run_scanner_reticle_layout_tests.sh
zsh tools/run_scan_tray_logic_tests.sh
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
```

## Runtime commands

Imported backend:

```bash
export SCRYDEX_API_KEY=your_api_key
export SCRYDEX_TEAM_ID=your_team_id
.venv-raw-visual-poc/bin/python backend/server.py \
  --database-path backend/data/spotlight_scanner.sqlite \
  --port 8788
```

- For the active visual runtime, use a Python environment that already has the visual matcher deps installed.
  - current known-good local command uses `.venv-raw-visual-poc/bin/python`
  - if you use a different Python, make sure it has `numpy`, `torch`, `transformers`, and `Pillow`

- For physical-device testing over LAN, bind the backend to all interfaces:

```bash
.venv-raw-visual-poc/bin/python backend/server.py \
  --database-path backend/data/spotlight_scanner.sqlite \
  --host 0.0.0.0 \
  --port 8788
```

- Nightly Scrydex full sync:

```bash
.venv-raw-visual-poc/bin/python backend/sync_scrydex_catalog.py \
  --database-path backend/data/spotlight_scanner.sqlite
```

- Example same-machine cron entry for the current prototype stage:

```bash
0 3 * * * cd /Users/stephenchan/Code/spotlight && .venv-raw-visual-poc/bin/python backend/sync_scrydex_catalog.py --database-path backend/data/spotlight_scanner.sqlite >> /Users/stephenchan/Code/spotlight/backend/logs/scrydex_sync.log 2>&1
```

Cloud Run deploy:

```bash
backend/deploy.sh staging backend/.env
backend/deploy.sh production backend/.env
```

Rules:

- keep non-secret Cloud Run runtime config in:
  - `backend/.env.staging`
  - `backend/.env.production`
- keep exactly one local backend secrets file:
  - `backend/.env`
- deploy merges the tracked runtime env file with `backend/.env` and sends that combined env payload to Cloud Run
- do not re-introduce duplicate local `.env` paths
- `backend/deploy.sh` is the one-command entrypoint; helper scripts may remain underneath but should not become the primary documented flow

The backend is always live-only. Do not reintroduce seeded startup or bundled catalog bootstrap modes.

## OCR Validation Direction

- Before deleting old OCR logic, require a fixture harness with named raw and slab golden cases.
- During migration, support a side-by-side OCR mode so old and new pipelines can run on the same input and emit diffable artifacts.
- Required stage artifacts for the new OCR path:
  - original full frame
  - selected target rectangle
  - normalized target crop
  - generated ROIs
  - OCR pass outputs per ROI
  - synthesized evidence object
  - final decision / fallback reason

## QA assets

- Simulator photo import: `tools/import_simulator_media.sh`
- OCR fixture manifests and the host baseline runner now live under `qa/` and `tools/` per [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- The simulator-backed legacy slab OCR fixture runner is now landed:
  - `zsh tools/run_ocr_simulator_fixture_tests.sh`
  - outputs: [qa/ocr-golden/simulator-legacy-v1](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-legacy-v1)
- The rewrite raw stage-2 branch is now the live raw runtime path:
  - simulator outputs: [qa/ocr-golden/simulator-rewrite-v1-raw-stage2](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-rewrite-v1-raw-stage2)
  - current scope:
    - `headerWide`
    - `footerBandWide`
    - `footerLeft`
    - `footerRight`
  - centralized tuning now lives in [OCRTuning.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/OCRTuning.swift)
  - raw evidence confidence now lives in [RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)
- Legacy OCR now emits a transitional `ocrAnalysis` envelope with normalized-target metadata, mode sanity scores/warnings, and legacy evidence fields.
- The next OCR milestone is slab branch stage 1 on top of that rewrite branch.

## Notes

- A `.git` directory may or may not be present depending on the workspace snapshot. Use `git status` when it exists, but do not rely on git state alone for change discovery.
- Prefer updating the backend reset spec, the OCR rewrite spec, the master status doc, and `PLAN.md` when milestones move.
- Before touching provider code, read the new provider-abstraction docs above. The intended behavior is:
  - one active/default provider result for the tray
  - future side-by-side provider display in details
  - no cross-provider averaging
- Important ops endpoints now exist:
  - `GET /api/v1/ops/provider-status`
  - `GET /api/v1/ops/unmatched-scans`
- The backend can import raw card records through `POST /api/v1/catalog/import-card`.
- Validate Scrydex creds/live provider wiring:
  - `python3 backend/validate_scrydex.py`
