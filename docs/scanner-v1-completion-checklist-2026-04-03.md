# Scanner V1 Completion Checklist

Date: 2026-04-04

This is the execution checklist to get the scanner from its current prototype state to a `fully functioning v1 application` for Pokemon card scanning.

Use this as the agent handoff checklist. Work top to bottom. Do not skip validation after each milestone.

## Definition Of Done

The scanner is considered `done for v1` when all of the following are true:

- raw cards can be scanned and priced reliably enough for real seller use
- PSA slabs can be scanned and priced reliably enough for real seller use
- unknown/fake/custom cards do not silently produce confident wrong matches
- the catalog stays fresh without manual intervention
- the app clearly shows source, freshness, fallback state, and confidence
- the app is fast enough to scan cards in sequence on the same screen
- the codebase has regression coverage for clean cards and real-world photos
- the repo has operational tools and docs so another agent can keep extending it cleanly

## Hard Ship Criteria

- raw modern English cards:
  - `>= 95%` top-1 accuracy on the clean regression pack
  - `>= 85%` top-1 or top-2 recoverable accuracy on the real-world pack
- PSA slabs:
  - `>= 90%` correct card + grade extraction on the current slab pack
- unsupported/custom/fake cards:
  - `0` silent high-confidence wrong matches in the unsupported pack
- scan latency:
  - row appears in tray within `<= 700ms` from local analysis result on warm backend
  - price refresh status is visible without blocking continued scanning
- stability:
  - backend tests green
  - image regression green
  - iOS build green

## Milestone 1: Freeze The Scanner Product Contract

- [x] Lock the v1 supported scope in docs:
  - Pokemon only
  - one card per photo
  - tray-first UI
  - raw cards + PSA slabs
  - English-first
- [x] Lock the unsupported scope:
  - multi-card binder pages
  - bulk continuous auto-detect without explicit capture
  - Japanese edge cases unless specifically imported/tested
  - exact BGS/CGC pricing unless implemented
- [x] Add one explicit `scanner-v1 supported / unsupported` section to the master status doc

Acceptance criteria:

- any new agent can answer `what does v1 support?` from one doc without guessing

Tests/docs:

- update [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)

## Milestone 2: Catalog Freshness

- [x] Build automated catalog sync job
  - nightly full sync
  - release-window accelerated sync
  - resumable sync state
- [x] Add live `catalog miss` lookup and immediate local cache write
- [x] Add release preload flow for upcoming sets
- [x] Add unmatched-card log for scans that fail or land in review
- [x] Add admin/report output for:
  - newly added cards
  - sync failures
  - cards still missing after scan attempts

Acceptance criteria:

- new real cards can enter the local catalog without manual code changes
- the app no longer depends on ad hoc one-off imports for newly released cards

Tests:

- unit tests for sync diff logic
- unit tests for miss-lookup cache insertion
- integration test for importing one new card after a miss

## Milestone 3: Raw Resolver Quality

- [x] Improve bottom-strip OCR reliability
  - stronger region cropping
  - orientation normalization
  - tighter collector number parsing
  - better set-hint extraction
- [ ] Broaden set code / symbol support
- [x] Improve fallback retrieval for older sets and edge-case variants
- [x] Expand older-era coverage for important cards:
  - XY / EX / vintage
  - popular chase cards that users will actually scan
- [x] Add review rules so weak raw scans never auto-accept incorrectly
- [x] Add clear UI reason when a raw card lands in review

Acceptance criteria:

- clean raw regressions stay green
- real-world raw cards improve without increasing fake-card false positives

Tests:

- expand `backend/tests/test_scanner_backend.py`
- expand `qa/scanner-regression.realworld-2026-04-03.json`
- add new real raw photos to `qa/images/realworld-*`

## Milestone 4: PSA Resolver Quality

- [x] Improve PSA label OCR robustness
  - grade
  - cert
  - year
  - set/name fragments
  - card number
- [ ] Add explicit label-region quality scoring
- [x] Handle small-in-frame slabs better
- [ ] Handle glare / partial label occlusion better
- [x] Distinguish:
  - exact PSA support
  - PSA identification only
  - raw proxy fallback
- [x] Add clear UI note when slab price is not true slab pricing

Acceptance criteria:

- slab pack scans correctly identify card + grade with the current real-world slab photos
- slab rows clearly state whether the shown number is exact slab pricing or fallback

Tests:

- expand slab OCR regression cases
- add more real slab images to real-world manifest
- add tests for grade extraction edge cases

## Milestone 5: Pricing Trust Layer

- [x] Keep Scrydex as active raw + PSA refresh provider
- [x] Decide fallback policy:
  - retain imported snapshot as cache fallback
  - or prefer Scrydex-only once refreshed
- [x] Add explicit freshness states:
  - cached
  - refreshed recently
  - stale
  - unavailable
- [x] Add explicit source labels:
  - Scrydex
  - slab comp model
  - raw proxy
- [x] Add explicit methodology summaries for rows
- [x] Make fallback states visually distinct so sellers do not mistake them for current market truth

Acceptance criteria:

- every price shown in the app has understandable source + freshness + fallback context

Tests:

- unit tests for pricing summary formatting/state selection
- backend tests for raw refresh, PSA refresh, fallback behavior

## Milestone 6: Live Slab Comp Coverage

- [x] Add production manifest/auth readiness validation
- [ ] Validate production sync for slab sale sources with real auth values
- [ ] Build real authenticated source configs
- [x] Add source health/failure visibility
- [ ] Tune tiered slab model:
  - exact same grade
  - nearby grades
  - bucket model
  - raw fallback
- [ ] Decide when Scrydex direct graded price should win vs local slab-comp model
- [ ] Add population/cert support only if it improves trust without harming latency

Acceptance criteria:

- slab pricing feels explainable and Card-Ladder-like enough for real seller use
- source failures do not silently degrade into misleading pricing

Tests:

- integration tests for slab sync import/recompute
- fixture coverage for exact-grade and nearby-grade modeling

## Milestone 7: Unsupported / Fake / Custom Card Handling

- [x] Build one explicit unsupported state in the UI
- [x] Replace vague weak-match behavior with:
  - unsupported
  - review needed
  - likely fake/custom
- [x] Add better copy so users know why a card was not matched
- [x] Add logging for unsupported-card scans
- [x] Keep impossible combinations from matching real cards

Acceptance criteria:

- unsupported cards feel intentional, not broken
- fake/custom cards do not get confident wrong prices

Tests:

- keep fake/custom real-world regression cases green
- add more unsupported fixtures when they show up

## Milestone 8: Speed And Event-Floor UX

- [x] Add automated latency benchmark runner
- [ ] Measure scan latency in the actual app
- [x] Remove unnecessary blocking/loading states
- [x] Keep camera live after every scan
- [x] Keep row insertion instant even if refresh is pending
- [x] Make local-fallback mode obvious when backend is unavailable
- [x] Add a small connection/source indicator so the user knows if pricing is live or fallback

Acceptance criteria:

- scanning multiple cards in a row feels smooth
- the app never hides whether it is using fallback mode

Tests:

- add tray-logic tests where needed
- record and compare typical timing on a sample device/simulator

Current benchmark:

- analysis avg `719.0ms`, p95 `1015.7ms`
- match avg `46.0ms`, p95 `171.1ms`
- total avg `764.9ms`, p95 `1088.7ms`

## Milestone 9: Real-World QA Pack

- [x] Build a larger real-world QA set:
  - sleeves
  - toploaders
  - PSA slabs
  - glare
  - angled shots
  - dark backgrounds
  - old cards
  - new set cards
  - unsupported/custom cards
- [x] Add all images into a stable manifest
- [x] Add one-command regression runner for this pack
- [x] Define accepted outcomes per card:
  - exact match
  - review expected
  - unsupported expected

Acceptance criteria:

- the team can re-run the whole real-world pack in one command

Tests:

- keep the real-world runner green
- add clear failure output for mismatched price/mode/confidence

## Milestone 10: Operational Visibility

- [x] Add sync status endpoint improvements
- [x] Add pricing provider health endpoint or health fields
- [x] Add unmatched-card metrics/logs
- [x] Add refresh failure logs
- [x] Add source freshness timestamps per provider

Acceptance criteria:

- you can quickly answer:
  - is the catalog fresh?
  - is Scrydex working?
  - are slab sources syncing?
  - what cards are failing in the field?

Tests:

- backend tests for status/health payloads

## Milestone 11: Code Quality And Cleanup

- [x] Remove inactive provider runtime code when it is no longer needed
- [ ] Remove stale docs that conflict with the active provider path
- [x] Keep one master status doc current
- [x] Keep `PLAN.md` current after each major milestone
- [x] Add/refine tests before refactors
- [x] Make sure every major scanner module has one clear owner/responsibility

Acceptance criteria:

- another agent can continue work without reverse-engineering old dead paths

Tests:

- all existing validation commands still pass

## Milestone 12: Final Ship Checklist

- [ ] raw scan happy path manually verified
- [ ] PSA slab happy path manually verified
- [ ] unsupported/fake card path manually verified
- [x] backend tests green
- [x] regression suites green
- [x] iOS build green
- [x] simulator install/launch verified
- [x] docs/plan/report updated
- [x] release notes / known limitations written

## Exact Validation Commands

Run after meaningful changes:

```bash
python3 -m py_compile backend/catalog_tools.py backend/import_pokemontcg_catalog.py backend/catalog_sync.py backend/sync_catalog.py backend/slab_source_sync.py backend/sync_slab_sources.py backend/scrydex_adapter.py backend/validate_scrydex.py backend/server.py
python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
zsh tools/run_scan_tray_logic_tests.sh
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
SPOTLIGHT_SCANNER_SERVER=http://127.0.0.1:8788/ zsh tools/run_scanner_regression.sh
zsh tools/run_realworld_regression.sh
SPOTLIGHT_BENCHMARK_ITERATIONS=1 zsh tools/run_scan_latency_benchmark.sh
python3 backend/sync_slab_sources.py --manifest backend/catalog/slab_sources.production.sample.json --validate
python3 backend/validate_scrydex.py
```

## Best Order To Leave An Agent Running

1. Milestone 2: Catalog freshness
2. Milestone 3: Raw resolver quality
3. Milestone 4: PSA resolver quality
4. Milestone 5: Pricing trust layer
5. Milestone 7: Unsupported/fake handling
6. Milestone 8: Speed and event-floor UX
7. Milestone 9: Real-world QA pack
8. Milestone 10: Operational visibility
9. Milestone 11: Code quality cleanup
10. Milestone 12: Final ship checklist

## Short Version

To finish scanner v1, you still need:

- automatic catalog freshness
- stronger raw and PSA resolver quality
- better unsupported/fake behavior
- trustworthy source/freshness labeling
- real-world regression coverage
- ops/logging
- cleanup and final ship validation
