# AGENTS

Repo-specific workflow notes for future coding agents.

## Scope

- This repo is a local iOS + Python backend prototype for a Pokemon card scanner.
- The active product/status doc is [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md).
- The active backend reset / raw-matcher redesign plan is [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- For backend work, treat that reset spec as the source of truth over older raw-matcher, `direct_lookup`, `slab_sales`, or fragmented SQLite planning notes elsewhere in the repo.

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

- Pricing provider abstraction is now implemented with specialized providers, but the current backend runtime is intentionally **raw-only** during the reset:
- Runtime scanner behavior is mode-specific, not cross-provider blended:
  - **Raw mode**:
    - resolve as `raw_card`
    - send OCR payloads directly to the backend matcher
    - refresh/display raw pricing from **Pokemon TCG API** only
  - **Slab mode**:
    - backend runtime support is intentionally removed for now
    - current raw-only backend should return unsupported rather than attempting slab matching/pricing
- PriceCharting and Scrydex remain as thin provider shells for env/config structure and later rebuild work, but they are not active runtime lanes right now.
- Each provider implements the shared `PricingProvider` contract.
- Provider prices are **not** blended or averaged together.
- The tray shows one active/default provider result.
- The architecture supports future side-by-side provider display in detail views.
- Pricing freshness rule:
  - persisted SQLite snapshot timestamps are the source of truth for the `24 hour` freshness window
  - runtime refresh should read existing snapshots first and only hit the live provider when the snapshot is stale or the caller explicitly requests `forceRefresh`
  - the in-memory provider cache may exist as an optimization, but it is not the correctness layer for scanner runtime behavior
- Implementation files:
  - [backend/pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py) - provider contract and registry
  - [backend/pricing_utils.py](/Users/stephenchan/Code/spotlight/backend/pricing_utils.py) - shared price normalization utilities
  - [backend/pokemontcg_pricing_adapter.py](/Users/stephenchan/Code/spotlight/backend/pokemontcg_pricing_adapter.py) - Pokemon TCG API implementation
  - [backend/pricecharting_adapter.py](/Users/stephenchan/Code/spotlight/backend/pricecharting_adapter.py) - PriceCharting implementation
  - [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py) - Scrydex implementation

## Backend Reset Direction

- The raw backend reset is active and intentionally replaced the old collector-number-first matcher:
  - old `direct_lookup`-first raw routing is removed from the active raw runtime path
  - runtime raw matching now uses evidence extraction -> title/broad retrieval -> footer rerank
  - runtime SQLite target is simplified around:
    - `cards`
    - `card_price_snapshots`
    - `scan_events`
- Raw redesign target:
  - title/header and broader text retrieve candidates first
  - footer OCR confirms, reranks, and breaks ties later
  - backend always returns a best candidate, even at low confidence
- Current compatibility note:
  - raw responses still surface `resolverPath = visual_fallback` to avoid breaking the current Swift enum/client contract
  - the underlying raw matcher is no longer the old visual/direct-lookup path
- Provider target after reset:
  - raw identity/pricing => Pokemon TCG API lane
  - slab identity/pricing => deferred until the slab rebuild lands
- Keep the app/backend split:
  - app = capture, normalize, OCR, structured hints
  - backend = candidate retrieval, identity resolution, pricing refresh, scan logging
- The full phase-by-phase checklist, strict helper names, route-opening logic, and confidence math live in [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).

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
    - raw/singles => Pokemon TCG API
    - future PSA/slabs => Scrydex after the slab rebuild
  - do not make Cloud Run correctness depend on a preseeded lightweight JSON catalog file or bundled local identifier asset
- Preferred raw runtime flow:
  - app OCR extracts collector number/text locally
  - app sends the OCR payload directly to the backend
  - the backend live-resolves from OCR number/hints and hydrates SQLite on demand
  - backend SQLite is a runtime cache for imported card metadata/pricing, not a required preseeded catalog
  - Cloud Run should not depend on a seeded local JSON catalog file to recognize standard raw cards
- Canonical raw scan flow:
  - 1. OCR reads card text and collector number
  - 2. app sends the scan payload directly to the backend
  - 3. backend checks SQLite for that card's existing metadata/pricing snapshot
  - 4. if SQLite has no card record, or no fresh pricing snapshot, backend fetches live data from Pokemon TCG API
  - 5. backend writes the hydrated card metadata/pricing snapshot into SQLite
  - 6. backend returns the normalized card detail/pricing payload to the user
  - 7. later scans of the same card should reuse SQLite until the stored snapshot is older than the `24 hour` freshness window
  - 8. once the stored snapshot is older than `24 hours`, backend should re-fetch live provider data, update SQLite, and then return the refreshed result
- Canonical slab scan flow:
  - deferred in the current raw-only backend contraction
  - do not rebuild slab behavior on top of deleted legacy slab modules
  - rebuild slabs later using the preserved thin Scrydex adapter and the 3-table SQLite model
- Freshness policy:
  - `updated_at` / persisted snapshot timestamps in SQLite are the correctness layer for freshness
  - the `24 hour` freshness window should be enforced against SQLite snapshot age
  - in-memory caches are allowed only as short-lived optimizations and must not decide correctness
  - `forceRefresh` should bypass the normal freshness gate and re-query the live provider
- Rich card metadata and pricing should come from runtime metadata/provider APIs:
  - raw/singles => Pokemon TCG API
  - future PSA/slabs => Scrydex
  - do not silently cross-fallback slab pricing into raw pricing in the scanner flow
  not from large checked-in image bundles.
- Do not use card-ID prefix hacks such as `me*` blocking in runtime matching or bundled identifier lookup.
- Do not re-introduce bundled/local raw identifier maps or client-side candidate hydration hints for raw scans.
- `backend/catalog/` has been deleted from the active backend. Do not reintroduce bundled catalog/image/sample artifacts as runtime dependencies.
- If current backend code still references local reference images for visual retrieval, call that out as legacy technical debt instead of expanding that pattern.
- Scanner presentation rule:
  - preserve the current raw-card OCR pipeline unless there is a concrete bug; raw footer OCR is working well now
  - tap-to-scan should use the current preview frame path first, not a new high-latency still-photo capture, unless preview-frame capture is unavailable and a fallback is required
  - the scan tray should show a pending row immediately on tap; do not reintroduce UX that waits for image capture to finish before the tray updates
  - treat raw-vs-slab reticle sizing as a UI/layout concern first, not a reason to casually retune raw OCR
  - raw mode should use a standard card-style reticle
  - slab mode should keep the same reticle width as raw and grow primarily by height based on PSA slab proportions
  - keep comfortable spacing above the reticle, between the reticle and controls, and between the controls and tray
  - the raw/slab toggle is a real routing signal, not presentation-only:
    - raw => raw-card matching/pricing flow
    - slab => PSA slab matching/pricing flow
  - do not silently degrade slab scans into raw matches or raw price proxies

## Key backend entry points

- `backend/server.py`
- `backend/catalog_tools.py`
- `backend/import_pokemontcg_catalog.py`
- `backend/pokemontcg_pricing_adapter.py`
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
python3 -m py_compile backend/catalog_tools.py backend/import_pokemontcg_catalog.py backend/pokemontcg_pricing_adapter.py backend/pricecharting_adapter.py backend/pricing_provider.py backend/pricing_utils.py backend/scrydex_adapter.py backend/validate_scrydex.py backend/server.py
python3 -m unittest -v backend.tests.test_backend_reset_phase1 backend.tests.test_raw_evidence_phase3 backend.tests.test_raw_retrieval_phase4 backend.tests.test_raw_decision_phase5 backend.tests.test_pricing_phase6 backend.tests.test_scan_logging_phase7 backend.tests.test_import_pokemontcg_catalog backend.tests.test_pricing_utils
zsh tools/run_card_identifier_parser_tests.sh
zsh tools/run_raw_card_decision_tests.sh
zsh tools/run_scanner_reticle_layout_tests.sh
zsh tools/run_scan_tray_logic_tests.sh
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
```

## Runtime commands

Imported backend:

```bash
export POKEMONTCG_API_KEY=your_api_key
python3 backend/server.py \
  --skip-seed \
  --database-path backend/data/spotlight_scanner.sqlite \
  --port 8788
```

- For physical-device testing over LAN, bind the backend to all interfaces:

```bash
python3 backend/server.py \
  --skip-seed \
  --database-path backend/data/spotlight_scanner.sqlite \
  --host 0.0.0.0 \
  --port 8788
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

Explicit seed/sample backend:

```bash
python3 backend/server.py \
  --cards-file /absolute/path/to/cards.json \
  --database-path /absolute/path/to/dev_seed.sqlite \
  --port 8787
```

## QA assets

- Simulator photo import: `tools/import_simulator_media.sh`
- Local raw/OCR fixtures and manifests still live under `qa/` for future OCR work, but the old bundled scanner regression/benchmark harnesses were intentionally removed during the raw-backend reset.

## Notes

- A `.git` directory may or may not be present depending on the workspace snapshot. Use `git status` when it exists, but do not rely on git state alone for change discovery.
- Prefer updating the backend reset spec, the master status doc, and `PLAN.md` when milestones move.
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
