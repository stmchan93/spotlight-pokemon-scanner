# React Native Parallel Execution Spec

Date: 2026-04-21

## Status

- This document is the locked execution brief for the React Native migration workstream.
- It supersedes open execution questions in [react-native-universal-migration-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-universal-migration-spec-2026-04-21.md).
- It is execution-only:
  - repo structure
  - phase order
  - ownership boundaries
  - testing and validation gates
  - subagent routing

## Locked decisions

- Keep the current Python backend in production.
- Keep the current SwiftUI iOS app in production until React Native mobile parity gates pass.
- Build the React Native app in parallel as a sibling app in this repo.
- Target iOS and Android first.
- Defer web to a later phase after mobile shell and scanner direction are stable.
- Do not rewrite the scanner first.
- Do not block backend or current iOS roadmap work on the React Native migration.

## Repo structure

Use a simple workspace, not a framework-heavy monorepo.

```text
/Users/stephenchan/Code/spotlight/
  Spotlight/                  # production SwiftUI iOS app
  SpotlightTests/
  SpotlightUITests/
  backend/                    # production Python backend
  docs/
  qa/
    api-contracts/            # shared JSON fixtures for backend <-> RN contracts
    mobile-e2e/               # Maestro flows, screenshots, device-matrix notes
  apps/
    spotlight-rn/             # Expo / React Native app
      app/                    # Expo Router routes
      src/
        features/             # feature modules by surface
        components/           # app-level composition
        hooks/
        state/
        services/
        native/               # platform bridges and native wrappers
        test/
      ios/
      android/
  packages/
    api-client/               # typed API client, DTOs, validators, contract tests
    design-system/            # tokens, primitives, theme snapshots
  package.json
  pnpm-workspace.yaml
```

### Boundary rules

- `Spotlight/` remains the scanner source of truth until cutover.
- `backend/` stays backward-compatible; RN work may add endpoints only if they are additive and safe for the Swift app.
- `packages/api-client/` owns request/response shapes consumed by RN.
- `packages/design-system/` owns tokens and cross-feature UI primitives for RN.
- `apps/spotlight-rn/` owns navigation, feature composition, app state, and platform-specific wiring.
- `qa/api-contracts/` stores frozen JSON fixtures shared by backend tests and RN contract tests.
- `qa/mobile-e2e/` stores end-to-end flows and golden screenshots for RN mobile.

## Phase plan

### Phase 0: freeze contracts and scaffold

- Freeze the backend routes and payloads the RN app will consume first:
  - auth/session
  - portfolio
  - inventory
  - ledger
  - manual search
  - card detail
  - sell/import flows
- Create `apps/spotlight-rn/`, `packages/api-client/`, `packages/design-system/`, and `qa/mobile-e2e/`.
- Add root `pnpm` workspace and CI entrypoints.
- Port Looty tokens into the design-system package.

Exit gate:
- RN workspace installs cleanly.
- typecheck, lint, unit-test, and contract-test commands exist and pass in CI.

### Phase 1: shell, auth, and shared primitives

- Build Expo Router shell for iOS and Android.
- Implement auth/session bootstrap against existing backend/auth services.
- Build the first locked primitive set:
  - `Surface`
  - `PrimaryButton`
  - `SecondaryButton`
  - `Pill`
  - `SectionHeader`
  - `FieldRow`
  - `SheetChrome`
  - `ArtworkCard`
  - `MetricCard`

Exit gate:
- iOS and Android smoke flows reach signed-in shell.
- visual snapshots for primitives are approved.

### Phase 2: universal non-scanner read surfaces

- Implement portfolio, inventory browser, ledger, and account surfaces in RN.
- Keep scanner entry in RN as a stub that routes users back to the production iOS app path or a placeholder on Android until scanner work starts.

Exit gate:
- RN iOS and Android can handle signed-in non-scanner daily use without falling back to SwiftUI.
- API contract fixtures remain green against backend.

### Phase 3: universal action flows

- Implement manual search, card detail, sell flows, buy flows, and import flows in RN.
- Keep scan review and scanner capture out of scope unless backed by the native bridge workstream.

Exit gate:
- seller workflows pass iOS and Android smoke tests
- no feature depends on scanner migration to ship internal alpha

### Phase 4: iOS scanner bridge

- Expose the existing native iOS scanner pipeline to RN through a narrow bridge.
- Reuse current backend contracts and confidence/review behavior.
- Keep the SwiftUI app shipping until bridge quality is proven.

Exit gate:
- iOS RN scanner hits parity on the locked smoke matrix
- no regression on raw/slab routing, OCR payload shape, or review states

### Phase 5: Android scanner implementation

- Build Android scanner path with its own native implementation or bridged module boundary matching RN scanner APIs.
- Raw first.
- Slab only after raw is stable.

Exit gate:
- Android raw scanner meets first-release acceptance
- slab support is explicitly either shipped or deferred with product signoff

### Phase 6: cutover decision

- Decide whether RN replaces the SwiftUI app for iOS non-scanner surfaces only, or for the full mobile shell.
- Keep SwiftUI scanner fallback available until RN scanner telemetry and QA are stable.

Exit gate:
- release checklist signed off by product, backend, mobile, and QA owners

### Phase 7: web later

- Start web only after mobile architecture, design system, and route model are stable.
- Default first web scope:
  - portfolio
  - inventory
  - ledger
  - account
  - imports
- Do not front-load live web scanner work.

## Workstream breakdown

Keep the parallel plan to five active lanes max.

### Lane 1: contract and backend compatibility

Owner:
- Architect -> Implementer -> QA

Scope:
- API inventory
- additive backend changes only
- contract fixtures
- backward-compatibility checks for SwiftUI

Primary files:
- `backend/`
- `qa/api-contracts/`
- `packages/api-client/`

### Lane 2: RN foundation

Owner:
- Architect -> Implementer

Scope:
- workspace
- Expo app bootstrap
- routing
- env config
- CI scripts

Primary files:
- root `package.json`
- `pnpm-workspace.yaml`
- `apps/spotlight-rn/`

### Lane 3: design system

Owner:
- Architect -> Implementer -> QA

Scope:
- tokens
- primitive components
- visual review baselines
- interaction states

Primary files:
- `packages/design-system/`
- `qa/mobile-e2e/`

### Lane 4: universal feature surfaces

Owner:
- Implementer only for isolated features
- Architect -> Implementer for multi-surface flows

Scope:
- portfolio
- inventory
- ledger
- account
- detail
- sell
- import
- manual search

Primary files:
- `apps/spotlight-rn/src/features/`
- `packages/api-client/`
- `packages/design-system/`

### Lane 5: scanner bridge and parity

Owner:
- Architect -> Implementer -> QA

Scope:
- iOS scanner bridge
- Android scanner implementation
- parity fixtures
- performance and reliability gates

Primary files:
- `Spotlight/`
- `apps/spotlight-rn/src/native/`
- `qa/mobile-e2e/`
- targeted backend contract fixtures only if required

## Parallelization rules

- Lanes 1, 2, and 3 can start together after the execution spec is approved.
- Lane 4 starts after:
  - route shell exists
  - auth works
  - tokens and primitives are stable enough for reuse
- Lane 5 starts only after:
  - RN shell is operational
  - the scanner API boundary is documented
  - QA has locked the parity matrix
- Do not let scanner bridge work block RN non-scanner shipping.
- Do not let RN feature work mutate scanner-native code outside the dedicated bridge lane.

## Testing strategy

### Test pyramid

- Backend:
  - keep existing Python unit and integration coverage
  - add contract-fixture verification for any endpoint the RN app depends on
- `packages/api-client/`:
  - schema decode tests
  - request/response fixture tests
  - backward-compatibility tests against frozen JSON samples
- `packages/design-system/`:
  - token tests
  - component render tests
  - visual snapshot tests for core primitives
- `apps/spotlight-rn/`:
  - unit tests for hooks, reducers, and state transitions
  - React Native Testing Library tests for screen behavior
  - platform smoke coverage for route boot, auth bootstrap, and core flows
- mobile end-to-end:
  - Maestro smoke flows on iOS and Android for release-candidate routes
- scanner lane:
  - keep native scanner regression suites in Swift
  - add RN bridge integration tests, not JavaScript-only mocks, for parity-critical scanner paths

### Required quality bars

- no untyped API responses in app feature code
- no direct fetch calls outside `packages/api-client/`
- no one-off color or spacing literals in feature screens once tokens exist
- every feature route ships with:
  - happy-path screen test
  - error-state test
  - loading-state test
- every additive backend contract change ships with:
  - backend test
  - updated fixture
  - RN contract test

## Validation gates and commands

These are the target commands to standardize once the workspace exists.

### Backend and contract lane

```bash
python3 -m py_compile backend/server.py backend/catalog_tools.py
python3 -m unittest backend.tests.test_manual_card_search
python3 -m unittest backend.tests.test_portfolio_imports
python3 -m unittest backend.tests.test_user_isolation
pnpm --filter api-client test
pnpm --filter api-client typecheck
```

### RN foundation and feature lanes

```bash
pnpm install --frozen-lockfile
pnpm --filter spotlight-rn lint
pnpm --filter spotlight-rn typecheck
pnpm --filter spotlight-rn test
pnpm --filter design-system test
pnpm --filter design-system test:snapshots
pnpm --filter spotlight-rn expo-doctor
```

### Mobile smoke lane

```bash
pnpm --filter spotlight-rn test:e2e:ios-smoke
pnpm --filter spotlight-rn test:e2e:android-smoke
```

### Existing production app safety lane

```bash
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
python3 -m unittest backend.tests.test_raw_retrieval_phase4
python3 -m unittest backend.tests.test_pricing_phase6
```

### Scanner bridge lane

```bash
zsh tools/run_card_identifier_parser_tests.sh
zsh tools/run_slab_label_parser_tests.sh
zsh tools/run_scanner_reticle_layout_tests.sh
pnpm --filter spotlight-rn test:scanner-bridge
pnpm --filter spotlight-rn test:e2e:scanner-ios
pnpm --filter spotlight-rn test:e2e:scanner-android
```

## Subagent routing

Default workflow should stay lightweight.

### Phase 0-1 routing

- one Architect handoff for:
  - repo layout
  - package boundaries
  - contract freeze
  - CI entrypoints
- one Implementer for RN foundation
- one Implementer for design system
- one QA pass across shell, tokens, and contract fixtures

### Phase 2-3 routing

- one Architect handoff per multi-surface feature cluster:
  - read surfaces
  - action flows
- one Implementer per feature cluster
- one QA pass per cluster before merge

Suggested feature clusters:
- portfolio + inventory
- ledger + transactions
- detail + manual search
- sell + import

### Phase 4-5 routing

- mandatory Architect -> Implementer -> QA chain
- scanner work must use a dedicated lane
- scanner bridge changes may touch `Spotlight/` but only within the bridge scope

## Merge and ownership rules

- One owner per lane at a time.
- `packages/api-client/` changes require review from backend lane owner.
- `packages/design-system/` changes require review from design-system lane owner.
- `Spotlight/` scanner changes require review from scanner lane owner.
- Backend changes for RN must remain additive until the SwiftUI app is retired.
- No lane should combine:
  - workspace bootstrap
  - feature delivery
  - scanner parity
  in the same PR.

## Cutover rule

- The SwiftUI iOS app remains the production app until:
  - RN non-scanner routes are stable
  - iOS RN scanner parity is proven or explicitly scoped out
  - Android release quality is acceptable
  - release QA signs off on the cutover matrix

Until then, the React Native app is a parallel product lane, not the replacement runtime.
