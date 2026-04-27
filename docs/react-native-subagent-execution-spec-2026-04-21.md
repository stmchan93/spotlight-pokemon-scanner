# React Native Subagent Execution Spec

Date: 2026-04-21

## Status

- This document defines the execution workflow for the locked React Native mobile migration brief.
- Use it for React Native UI-parity work only.
- Keep the current SwiftUI iOS app and the backend intact while this work is in progress.

Primary source of truth:

- [react-native-universal-migration-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-universal-migration-spec-2026-04-21.md)

## Scope Lock

- mobile only:
  - `iOS`
  - `Android`
- web later
- design parity and UI architecture only
- first spike page:
  - `Portfolio`

Out of scope for the first execution wave:

- backend changes
- scanner migration
- OCR work
- web
- product-model changes

## Required Agent Chain

Use:

- `Architect -> Implementer -> QA`

Do not skip QA for the first React Native spike because the risk is visual regression and scope drift, not backend correctness.

## Architect Brief

### Mission

Freeze the implementation target before any React Native code is written.

### Read first

- [AGENTS.md](/Users/stephenchan/Code/spotlight/AGENTS.md)
- [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)
- [docs/react-native-universal-migration-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-universal-migration-spec-2026-04-21.md)
- [PortfolioView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/PortfolioView.swift)
- [ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- [ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
- [SellOrderSheets.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/SellOrderSheets.swift)

### Deliverable

Produce a short handoff with:

- `Scope:`
- `Files:`
- `Acceptance:`
- `Validation:`
- `Risks:`

### Architect checklist

- confirm the first spike is `Portfolio`
- freeze the two-tab floating shell
- define the token surface for fonts, spacing, radius, and color
- identify reference screenshots to capture before implementation
- define which current SwiftUI surfaces are parity references vs later follow-on work

## Implementer Brief

### Mission

Build the React Native Portfolio spike to the locked design rules without touching backend or scanner behavior.

### Allowed work

- React Native app shell
- token layer
- font loading
- floating bottom nav
- Portfolio screen
- local fixture data or typed mock payloads for UI proofing

### Not allowed

- backend schema or API changes
- camera/scanner implementation
- extra tabs
- web adaptation
- style improvisation outside the locked brief

### Implementation order

1. Create the token and typography layer.
2. Build the floating `72px` bottom nav with `Portfolio` and dominant `Scan`.
3. Build the Portfolio header and section rhythm.
4. Build the density toggle with `2/3/4/5`, default `3`.
5. Build the Recent Sales section with the locked count, row height, padding, and header layout.
6. Capture comparison screenshots before expanding scope.

### Expected file surface

- React Native shell files only
- shared token/component files only
- no backend Python files
- no Swift scanner files

## QA Brief

### Mission

Verify that the Portfolio spike proves design parity rather than just functional completeness.

### Review focus

- typography is correct:
  - `Special Gothic Expanded One`
  - `Outfit`
- nav geometry and emphasis are correct
- spacing matches the locked values
- density toggle defaults correctly
- Recent Sales respects max rows and row layout
- nothing extra was added to the shell
- the result does not look like default React Native or Material chrome

### Required evidence

- iPhone-class screenshots against the approved references
- Android screenshots confirming on-brand translation
- exact list of any deviations still open

## Reference Capture Requirement

Before implementation review is considered complete, produce a reference pack containing:

- current SwiftUI Portfolio screenshots
- user-provided scanner shell screenshot
- any approved detail/sell reference crops needed for follow-on work

Do not let engineers work from memory once the spike enters visual polish.

## Validation Commands

Use these once the React Native app exists:

- `cd rn && npm run lint`
- `cd rn && npm run typecheck`
- `cd rn && npx expo start --ios`
- `cd rn && npx expo start --android`

Manual validation remains mandatory for this spike because the success bar is visual:

- compare screenshots side-by-side against approved references
- verify the locked dimensions and shell rules

## Done Criteria

The first React Native spike is done only when:

- the page is `Portfolio`
- the shell is locked to `Portfolio + Scan`
- scan is visually dominant
- the typography is correct
- the Portfolio spacing and density controls are correct
- Recent Sales is locked to the requested layout rules
- QA signs off that the result is pixel-close or better

## Handoff Format

Every agent handoff must use:

- `Scope:`
- `Files:`
- `Acceptance:`
- `Validation:`
- `Risks:`

Keep it short. Do not send broad repo summaries or implementation diaries.
