# AGENTS

Repo-specific workflow notes for future coding agents.

## Scope

- This repo is a local iOS + Python backend prototype for a Pokemon card scanner.
- The active product/status doc is [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md).

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

- Pricing provider abstraction is now implemented with specialized providers:
- Runtime scanner behavior is mode-specific, not cross-provider blended:
  - **Raw mode**:
    - resolve as `raw_card`
    - send OCR payloads directly to the backend matcher
    - refresh/display raw pricing from **Pokemon TCG API** only
  - **Slab mode**:
    - resolve as `psa_slab`
    - send slab OCR payloads directly to the backend matcher
    - refresh/display PSA/slab pricing from **Scrydex** only
    - if PSA label OCR or Scrydex pricing is unavailable, surface unsupported/no-price instead of falling back to raw pricing
- PriceCharting may remain registered for diagnostics/manual experiments, but it is **not** the default scanner source of truth.
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

## Planned scanner decision spec

- This section is the agreed target behavior for upcoming scanner work. Treat it as the implementation plan even if current runtime behavior still has older PSA-only or stricter fallback assumptions in places.
- Scanner mode remains authoritative:
  - `raw` mode => raw-card OCR payload + raw-card pricing lane
  - `slab` mode => slab OCR payload + slab pricing lane
  - no hidden cross-degrade between raw and slab flows
- Bias toward aggressive best-effort identification, not conservative rejection:
  - when OCR is incomplete, still return the best guess payload/candidate available
  - keep detailed failure reasons in logs/debug artifacts, not in user-facing UI

### Planned raw-card logic

- Raw-card identity is still anchored on footer OCR:
  - primary signals: collector number + set hint
  - footer regions remain the most important OCR targets
  - title/name clues are secondary support, not the primary contract
- Raw mode must first-class support:
  - naked raw cards
  - raw cards in sleeves
  - raw cards in toploaders or similar rigid holders
  - slightly off-center captures
  - slightly farther-away captures
  - mildly blurry or mildly reflective captures, as long as the footer is still reasonably recoverable
- Reticle behavior:
  - the reticle is a positioning hint, not an exact OCR crop
  - target selection should tolerate cards that are not perfectly centered inside the reticle
- Pre-OCR target logic for raw:
  - detect the best target near the reticle
  - allow holder-aware geometry, not just naked-card geometry
  - if the chosen rectangle is a holder/toploader, derive an inner-card crop before footer OCR
  - normalize the card upright before running footer OCR
- OCR order for raw:
  - bottom-left
  - bottom-right
  - bottom-full fallback
  - optional broader fallback only after the footer-specific path is exhausted
- Minimum useful raw signal:
  - ideal: collector number + set hint
  - if that fails, still send the strongest best-effort raw payload to the backend rather than hard-failing locally
- Capture fallback for raw:
  - use preview-frame capture first
  - allow automatic still-photo fallback only when geometry looks good but footer OCR quality is too weak
  - do not default all scans to still-photo capture

### Planned slab logic

- Slab mode stays top-label-first:
  - primary OCR target is the slab header/label
  - the app should extract grader, grade, card-number clue, set/name clue, and cert number when visible
- Grader support target:
  - recognize and price all graders supported by Scrydex, not PSA-only
  - current runtime/code may still contain PSA-oriented assumptions that need to be removed during implementation
- Cert number role:
  - cert is an auxiliary clue / shortcut when available
  - it is not the only allowed lookup path
- Preferred slab resolution flow:
  - identify the underlying card from label clues
  - resolve the exact card id
  - choose the most likely variant automatically
  - choose the most likely graded price row for the detected grader/grade
- If slab grade/grader/cert is weak:
  - still return the identified card and best pricing guess
  - do not hard-fail just because one slab field is weak

### Planned backend/provider ownership

- Keep provider-specific query construction in the backend, not the app.
- Raw provider direction remains unchanged:
  - raw pricing stays on the current raw provider lane
- Slab provider direction:
  - use Scrydex to resolve the underlying card and the graded pricing
  - app sends OCR-derived clues; backend owns provider search, exact id resolution, variant selection, and price-row selection
- Scrydex mental model for planned slab work:
  - OCR result => set/label clues + printed/card number + grader/grade/cert
  - backend resolves exact card id
  - backend uses that id for metadata/detail/pricing requests
  - backend chooses the most likely variant automatically
  - backend chooses the most likely graded price row automatically

### Planned quality/debug rules

- Distinguish failures in logs/debug artifacts, not UI:
  - target not localized
  - wrong geometry type
  - holder/toploader detected
  - target localized but footer/label text too small
  - glare / contrast issue
  - automatic still-photo escalation
  - weak grader / weak grade / weak variant selection
- When evaluating new scanner work, use real-world off-center and slightly zoomed-out cases as required acceptance cases, especially:
  - raw cards where the footer is visible but not perfectly centered
  - raw cards inside toploaders
  - reflective / shiny raw cards
  - slab labels with imperfect centering

### Planning guardrails

- Do not rewrite the OCR/parser stack just because one image is weak.
- Solve geometry and target-normalization issues before changing parsing heuristics.
- Preserve the current app/backend split:
  - app = capture, normalize, OCR, structured hints
  - backend = resolve identity, choose provider record, choose pricing payload
- If docs conflict:
  - preserve current runtime behavior unless the task is explicitly changing it
  - but use this section as the source of truth for planned scanner-direction work

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
    - PSA/slabs => Scrydex
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
  - 1. slab OCR reads the PSA label/cert/grade path
  - 2. app sends slab payload directly to the backend
  - 3. backend checks SQLite for an existing slab snapshot for the resolved card/grade context
  - 4. if the slab snapshot is missing or stale, backend fetches live slab metadata/pricing from Scrydex, writes it into SQLite, and returns it
  - 5. if PSA label OCR or Scrydex data is insufficient, return unsupported/no-price; do not fall back to raw-card pricing
- Freshness policy:
  - `updated_at` / persisted snapshot timestamps in SQLite are the correctness layer for freshness
  - the `24 hour` freshness window should be enforced against SQLite snapshot age
  - in-memory caches are allowed only as short-lived optimizations and must not decide correctness
  - `forceRefresh` should bypass the normal freshness gate and re-query the live provider
- Rich card metadata and pricing should come from runtime metadata/provider APIs:
  - raw/singles => Pokemon TCG API
  - PSA/slabs => Scrydex
  - do not silently cross-fallback slab pricing into raw pricing in the scanner flow
  not from large checked-in image bundles.
- Do not use card-ID prefix hacks such as `me*` blocking in runtime matching or bundled identifier lookup.
- Do not re-introduce bundled/local raw identifier maps or client-side candidate hydration hints for raw scans.
- Treat `backend/catalog/pokemontcg/images/` as a legacy importer artifact, not a required product/runtime asset.
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
- `backend/scrydex_adapter.py`
- `backend/slab_source_sync.py`
- `backend/catalog_sync.py`
- `backend/sync_catalog.py`
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
python3 -m py_compile backend/catalog_tools.py backend/import_pokemontcg_catalog.py backend/catalog_sync.py backend/sync_catalog.py backend/slab_source_sync.py backend/sync_slab_sources.py backend/scrydex_adapter.py backend/validate_scrydex.py backend/server.py
python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
zsh tools/run_card_identifier_parser_tests.sh
zsh tools/run_scanner_reticle_layout_tests.sh
zsh tools/run_scan_tray_logic_tests.sh
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
SPOTLIGHT_SCANNER_SERVER=http://127.0.0.1:8788/ zsh tools/run_scanner_regression.sh
zsh tools/run_realworld_regression.sh
SPOTLIGHT_BENCHMARK_ITERATIONS=1 zsh tools/run_scan_latency_benchmark.sh
zsh tools/run_scan_performance_tests.sh
```

## Runtime commands

Imported backend:

```bash
export SCRYDEX_API_KEY=your_api_key
export SCRYDEX_TEAM_ID=your_team_id
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

Sample backend:

```bash
python3 backend/server.py \
  --cards-file backend/catalog/sample_catalog.json \
  --database-path backend/data/sample_scanner.sqlite \
  --port 8787
```

## QA assets

- Clean image regression runner: `tools/run_scanner_regression.sh`
- Real-world image regression runner: `tools/run_realworld_regression.sh`
- Latency benchmark runner: `tools/run_scan_latency_benchmark.sh`
- Simulator photo import: `tools/import_simulator_media.sh`

## Notes

- A `.git` directory may or may not be present depending on the workspace snapshot. Use `git status` when it exists, but do not rely on git state alone for change discovery.
- Prefer updating the master status doc and `PLAN.md` when milestones move.
- Before touching provider code, read the new provider-abstraction docs above. The intended behavior is:
  - one active/default provider result for the tray
  - future side-by-side provider display in details
  - no cross-provider averaging
- Important ops endpoints now exist:
  - `GET /api/v1/ops/provider-status`
  - `GET /api/v1/ops/catalog-sync-status`
  - `GET /api/v1/ops/pricing-refresh-failures`
  - `GET /api/v1/ops/unmatched-scans`
- The backend can now import live catalog misses through `POST /api/v1/catalog/import-card` and `POST /api/v1/catalog/resolve-miss`.
- Production slab-source manifest sample exists at `backend/catalog/slab_sources.production.sample.json`.
- Validate slab-source auth/readiness without running sync:
  - `python3 backend/sync_slab_sources.py --manifest backend/catalog/slab_sources.production.sample.json --validate`
- Validate Scrydex creds/live provider wiring:
  - `python3 backend/validate_scrydex.py`
