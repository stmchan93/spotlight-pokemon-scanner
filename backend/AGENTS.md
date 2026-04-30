# AGENTS

Backend-specific workflow notes for future coding agents.

## Scope

- This directory owns the Python runtime backend for Spotlight scanner, inventory, portfolio, and pricing flows.
- Treat the backend as the source of truth for runtime card metadata, persisted pricing snapshots, scan logging, scan artifacts, confirmations, and deck state.
- Treat mobile clients as capture and request-orchestration surfaces. Backend responsibilities are:
  - visual retrieval
  - OCR rerank and evidence resolution
  - identity resolution
  - pricing refresh policy
  - scan logging and artifact persistence

## Read First

- Start with root repo rules in [AGENTS.md](/Users/stephenchan/Code/spotlight/AGENTS.md).
- Start with the current product/runtime summary in [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md).
- Use [docs/agent-context-index.md](/Users/stephenchan/Code/spotlight/docs/agent-context-index.md) to find the current source-of-truth doc for the subsystem you are touching.
- For raw identity and retrieval work, read:
  - [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)
  - [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md)
  - [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
- For the landed OCR-primary baseline only, read [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- For slab identity and OCR work, read [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md).
- For scan artifact, confirmation, and labeling semantics, read [docs/scan-data-labeling-pipeline-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scan-data-labeling-pipeline-spec-2026-04-23.md).
- For local run, deploy, and health-check commands, read [backend/README.md](/Users/stephenchan/Code/spotlight/backend/README.md).
- Keep volatile rollout numbers, held-out metrics, dataset roots, active artifact aliases, and VM operations out of this file. Use the docs above as the source of truth.

## Hard Invariants

- Scrydex is the active runtime identity/reference/pricing lane for raw cards and the intended slab lane. PriceCharting remains a thin non-active shell.
- Do not add a PSA API or any official PSA verification dependency. Treat slab certs as OCR-derived lookup keys and repeat-scan cache keys only.
- Provider prices are not blended or averaged together. The runtime returns one active provider result.
- Runtime scanner behavior is mode-specific:
  - raw resolves as `raw_card`
  - slabs resolve through the cert-first slab path
- SQLite persisted metadata and pricing snapshots are the correctness layer for normal runtime reads.
- When live pricing is `off`, runtime reads must stay SQLite-only:
  - no hidden provider refreshes
  - no Scrydex exact-card import or fetch-by-id fallback
  - missing local rows should return `not found`
- When live pricing is `on`, metadata still comes from SQLite. Pricing may refresh live for the matched card plus top candidates when the stored snapshot is missing or stale, and the refreshed snapshot must be persisted back to SQLite.
- `forceRefresh` may bypass the normal freshness gate only when live pricing is enabled. It must not punch through the live-pricing-off SQLite-only rule.
- Keep raw and slab evidence extraction, candidate scoring, and resolver routing separate. Share pricing/context plumbing only after identity resolution.
- Candidate metadata always comes from SQLite.
- Runtime top `K` remains `10`.
- Scan artifacts are private. Do not make scan artifact binaries public.
- Do not reintroduce bundled catalog JSON, bundled image artifacts, `backend/catalog/`, or other local bootstrap data as runtime dependencies.
- The backend is live-only. Do not restore seeded startup or old catalog bootstrap modes.

## Raw Rules

- Treat [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md) as the source of truth over older `direct_lookup`, OCR-primary, or fragmented SQLite notes.
- Treat [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md) as the source of truth for raw set evidence and provider behavior.
- The long-term raw path is visual retrieval first, OCR rerank second. Do not add new OCR-primary matcher branches as if they are the target architecture.
- Trusted raw set evidence is badge-first. Broad footer or header OCR text should not be promoted into trusted set evidence by default.
- The normalized target image produced by the app is the source-of-truth query image for visual matching, not the raw source capture.
- Keep the raw migration order disciplined:
  - prove visual matching on live normalized images first
  - do not front-load large cleanup or harness work before the proof
  - improve the visual model before adding more OCR tuning after the first hybrid baseline
- Raw responses may preserve compatibility fields required by current clients, but do not treat compatibility naming as the desired architecture.
- Prefer extracting raw identity logic into cleaner backend seams instead of expanding [catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py) indefinitely.
- For current raw model metrics, dataset workflows, and active artifact aliases, read:
  - [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
  - [docs/raw-visual-local-dataset-workflow-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-local-dataset-workflow-2026-04-12.md)

## Slab Rules

- Treat [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md) as the source of truth for slab OCR and backend behavior.
- Phase-1 slab scope is cert-first PSA Pokemon only until explicitly expanded.
- Cert resolution order is:
  - barcode
  - OCR cert
  - repeat-scan cert cache
  - label-text fallback
- Slab resolution is cert-first, not cert-only. Preserve fallback title, set, and card-number evidence when available.
- Grader and grade remain explicit runtime fields for display context and pricing selection.
- Do not add raw-style visual matching for slabs.
- Identity may succeed with `pricing = null`.
- Do not broaden into non-PSA support, salvage heuristics, or official verification behavior without an explicit follow-up spec.

## Data And Artifact Rules

- Scan capture, matcher prediction, scan selection, and deck confirmation are separate states.
- Store two scan images for artifact capture:
  - `source_capture`
  - `normalized_target`
- `source_capture` must be the real production capture image from scan time, not a synthetic zoom variant.
- `normalized_target` must be the image that actually went through matcher or OCR flow.
- Matcher output is not ground truth:
  - `predicted_card_id` = backend top guess at scan time
  - `selected_card_id` = card chosen in review flow
  - `confirmed_card_id` = trusted label only after explicit `Add to deck`
- Do not collapse or overwrite `predicted_card_id`, `selected_card_id`, and `confirmed_card_id`.
- `Add to deck` is the trusted confirmation event for labeled training data.
- `selected_card_id` without confirmation is a weak label only.
- Deck dedupe semantics must match runtime behavior:
  - raw cards dedupe by `card_id`
  - slabs dedupe by `card_id + grader + grade + cert + variant`
- The runtime schema is broader than the original three-table core. `cards`, `card_price_snapshots`, and `scan_events` remain the identity/pricing spine, with artifact, confirmation, candidate, and deck tables layered on top.

## Key Files

- [server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- [catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)
- [schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
- [pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py)
- [pricing_utils.py](/Users/stephenchan/Code/spotlight/backend/pricing_utils.py)
- [scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py)
- [pricecharting_adapter.py](/Users/stephenchan/Code/spotlight/backend/pricecharting_adapter.py)
- [slab_cert_resolver.py](/Users/stephenchan/Code/spotlight/backend/slab_cert_resolver.py)
- Badge-first raw set evidence currently lives in [catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py) and [server.py](/Users/stephenchan/Code/spotlight/backend/server.py).
- [sync_scrydex_catalog.py](/Users/stephenchan/Code/spotlight/backend/sync_scrydex_catalog.py)
- [README.md](/Users/stephenchan/Code/spotlight/backend/README.md)

## Backend Validation Commands

- Compile the kept backend surface after Python changes:

```bash
python3 -m py_compile \
  backend/catalog_tools.py \
  backend/pricecharting_adapter.py \
  backend/pricing_provider.py \
  backend/pricing_utils.py \
  backend/scrydex_adapter.py \
  backend/sync_scrydex_catalog.py \
  backend/validate_scrydex.py \
  backend/server.py
```

- Run the baseline backend suite:

```bash
backend/run_all_tests.sh
```

- Run focused backend tests for the area you changed. Common modules include:

```bash
python3 -m unittest -v backend.tests.test_raw_evidence_phase3
python3 -m unittest -v backend.tests.test_raw_retrieval_phase4
python3 -m unittest -v backend.tests.test_raw_decision_phase5
python3 -m unittest -v backend.tests.test_pricing_phase6
python3 -m unittest -v backend.tests.test_scan_logging_phase7
python3 -m unittest -v backend.tests.test_scan_two_phase_phase8
python3 -m unittest -v backend.tests.test_labeling_sessions
python3 -m unittest -v backend.tests.test_user_isolation
```

- Validate live Scrydex env wiring when provider or deploy config changes:

```bash
python3 backend/validate_scrydex.py
```

- For current run, deploy, sync, and health-check commands, use [backend/README.md](/Users/stephenchan/Code/spotlight/backend/README.md) instead of duplicating ops snippets here.
