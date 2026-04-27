# React Native Locked Migration Brief

Date: 2026-04-21

## Status

- This document is the locked migration brief for moving the current app toward React Native.
- It supersedes earlier exploratory framing where this document is more specific.
- This is the decision brief for execution, not just an evaluation memo.
- The goal is to preserve the current product quality while unlocking Android and later web support.

## Locked Decision

Looty should migrate to a parallel React Native app while the current iOS SwiftUI app remains in production.

The migration should be:
- iOS + Android first
- web later
- backend preserved
- scanner handled as a separate native/platform-specific track
- portfolio page used as the first React Native spike

Do **not** do a big-bang rewrite.

## Why This Is Locked

The product goal is now clear:
- iOS and Android are the primary platforms
- web is a bonus and may come later
- the current iOS app is already strong enough to keep in users' hands while React Native work happens in parallel
- the migration is driven by a near-term need to become cross-platform without throwing away the current app quality

## Product Goal

The product should become:
- one strong mobile product on iOS and Android
- one later web surface for portfolio / inventory / selling / account / manual search / imports / sales history

The browser does **not** need full scanner parity in phase 1.

Browser support can be:
- upload-only for scan-adjacent behavior, or
- no scanner at all initially

The scanner remains a phone-first feature.

## Locked Platform Scope

### Phase 1 platforms

- iOS
- Android

### Phase 2 platform

- web

### Locked web scope for later

When web work begins, it should include:
- portfolio
- inventory
- selling
- account
- manual search
- imports
- sales history

It does **not** need full live scanner support in the first web slice.

## Locked Delivery Strategy

### Production rule

- keep the current SwiftUI iOS app in production
- build the React Native app in parallel

### First spike rule

The first React Native spike is:
- Portfolio page
- on iOS + Android

### Success bar for the first spike

The first spike must be:
- pixel-close to the current app
- or better

“Good enough but obviously different” is **not** acceptable.

## Locked Architecture

### Keep

- Python backend
- current API contracts where possible
- current product model
- current data flow through backend endpoints

### Replace gradually

- app shell
- navigation
- auth UI shell
- portfolio UI
- inventory UI
- seller flows
- detail views
- imports
- account

### Do not force into early JavaScript parity

- camera session stack
- OCR preprocessing
- target selection / perspective normalization
- scanner-native tactile behavior

Those stay platform-specific until proven otherwise.

## Current Codebase Reality

Current client/backend scale:
- app:
  - `53` Swift files
  - about `34k` Swift LOC
- backend:
  - `39` Python files
  - about `30k` Python LOC

Key client surfaces:
- app shell:
  - [SpotlightApp.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/SpotlightApp.swift)
- service wiring:
  - [AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
- backend API boundary:
  - [CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)
- portfolio:
  - [PortfolioView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/PortfolioView.swift)
- detail:
  - [ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
- sell flows:
  - [SellOrderSheets.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/SellOrderSheets.swift)
  - [ShowsView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ShowsView.swift)
- scanner:
  - [ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
  - [ScannerView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerView.swift)
  - [CameraSessionController.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CameraSessionController.swift)
  - [ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)

## Locked Design Direction

The current app visual identity is part of the product and must be preserved.

### Core visual direction

- light-first
- warm off-white paper tones
- yellow/gold brand accent
- strong black text
- rounded geometry
- clean elevated white cards
- subtle borders over heavy shadow
- modern collector/dealer polish
- immersive black scanner shell
- motion that is restrained, not gimmicky

Theme source:
- [LootyTheme.swift](/Users/stephenchan/Code/spotlight/Spotlight/UI/LootyTheme.swift)
- [LootyComponents.swift](/Users/stephenchan/Code/spotlight/Spotlight/UI/LootyComponents.swift)
- [SellModalComponents.swift](/Users/stephenchan/Code/spotlight/Spotlight/UI/SellModalComponents.swift)

### Locked fonts

Use:
- `Special Gothic Expanded One`:
  - all large titles
  - section headers
  - screen titles
- `Outfit`:
  - all body text
  - all caption text

Provided local assets:
- `/Users/stephenchan/Downloads/Outfit,Special_Gothic_Expanded_One.zip`
- `/Users/stephenchan/Downloads/Special_Gothic_Expanded_One.zip`

Implementation rule:
- vendor the needed font files into the repo/app assets
- do not rely on `Downloads/` paths at runtime

### Locked spacing system

Use a 4-point grid discipline:
- spacing, paddings, radii, control heights, and layout measurements should generally resolve to multiples of 4

Interpretation of “4 point pixel grade”:
- treat it as a `4pt grid` rule unless later corrected

### Locked token preservation

Do not redesign away from current tokens.

Carry forward the current theme semantics:
- `canvas`
- `canvasElevated`
- `surface`
- `surfaceMuted`
- `surfaceLight`
- `pageLight`
- `field`
- `brand`
- `success`
- `info`
- `warning`
- `danger`
- `textPrimary`
- `textSecondary`
- `textInverse`
- `outlineSubtle`
- `outlineStrong`

## Locked Interaction Direction

### Gestures

Target interaction model:
- swipe-back on screens where it is appropriate
- horizontal swipe navigation between major pages/tabs
- same gesture model on Android if feasible

Current lock:
- gesture direction and behavior should be explored in implementation, but the design intent is clear enough to proceed
- exact gesture conflict tuning is **not** fully locked yet

### Haptics / vibration

- keep haptics on iOS
- add Android vibration feedback

### Scanner capture behavior

The current scanner behavior is acceptable for now.

Do not introduce extra photo-capture animation work at this stage.

## Locked Bottom Navigation Direction

Reference direction:
- floating nav style inspired by the user-provided Collectr screenshot

Locked requirements:
- floating bottom nav
- `72px` total height target
- only `Portfolio` and `Scan` tabs for now
- `Scan` remains visually dominant
- web can later use side nav on desktop

Design rule:
- iOS may use glass / translucent treatment
- Android should preserve the same overall design language, but exact glass parity is not required

## Locked Portfolio Screen Spec

Primary reference:
- user-provided screenshots of current Portfolio / Inventory / Latest Sales

Portfolio rules now locked:
- horizontal page margins: `16px`
- density control: segmented toggle `2 / 3 / 4 / 5`
- default density: `3`
- no need to persist density per user initially
- `See more` should live next to the `Inventory` title
- `Recent Sales` should:
  - show a chevron next to the title
  - have a `View all` action on the right
  - open a dedicated sales history screen
- max recent sales shown in the home surface: `9`
- recent sale card height: `96px`
- recent sale card internal padding: `8px`
- recent sales section spacing target: `32px`

### Portfolio chart

Locked chart behavior:
- portfolio remains a line chart
- sales remains a bar chart
- time ranges:
  - `7D`
  - `1M`
  - `3M`
  - `1Y`
  - `ALL`
- x-axis:
  - show first and last labels only
- y-axis:
  - show `0`
  - midpoint
  - top bound
- remove the vertical gray hover/crosshair line

## Locked Product Detail Screen Spec

Reference direction:
- user-provided current product detail screenshots

Locked changes:
- remove the top-left dollar figure
- use the exact sell-page gradient token for the hero background
- permanently remove the bottom metadata chips
- show full condition labels everywhere, not abbreviations only
- `In your collection` should:
  - become roughly 2x taller than current
  - include full condition text
  - include an edit icon
  - open a full collection item editor

### Inventory trash behavior

Locked behavior:
- trash decrements quantity by `1`
- when quantity reaches `0`, remove the row entirely

### Navigation behavior

Locked intent:
- portfolio and scanner should feel swipe-connected
- detail swipe should return to the portfolio/inventory context

Exact gesture mechanics still need implementation tuning.

### Product detail graph

Locked rule:
- green replaces yellow only in the product-detail market-price graph for price-up styling

## Locked Sell Screen Spec

Reference direction:
- user-provided current sell screenshots

Locked layout rules:
- `40px` between hero image and sell form
- `16px` page side margins
- card number should always appear next to the product name block
- `16px` between image and text block
- shift the sell content upward by `40px`

Locked photo behavior:
- `Photo (optional)` opens camera
- captured photo replaces the camera icon with a compact thumbnail row

Locked confirm behavior:
- keep swipe-up-to-sell for now
- require `50%` or more threshold
- after successful sale, return to portfolio home

## Locked Scanner Direction

Reference direction:
- user-provided current scanner screenshot

Locked migration rule:
- the scanner should **not** block the React Native shell migration
- scanner work is a later native/platform-specific track
- React Native migration can begin with non-scanner surfaces first

This is intentional even if scanner improvements are still needed.

## Locked Priorities

Top priority themes:
- React Native migration
- preserved look and feel
- preserved interactions

This means:
- design parity is a core requirement, not polish debt
- architecture should be chosen to protect the current visual/interaction quality

## Recommended Order Of Work

1. lock migration brief and execution specs
2. build React Native design system and app shell
3. build Portfolio spike on iOS + Android
4. validate pixel-close parity against current screenshots
5. continue with inventory / recent sales / bottom nav within the same RN shell
6. move product detail
7. move sell flow
8. decide scanner-native bridging / RN scanner path
9. add later web support for non-scanner routes

## What Is In Scope Right Now

- locked migration brief
- RN app shell strategy
- RN design system strategy
- portfolio-first spike
- iOS + Android first
- later web-ready architecture
- screen-level rules for:
  - portfolio
  - latest sales
  - bottom nav
  - product detail
  - sell

## What Is Not Fully Locked Yet

The following can be handled later with more screenshots/prompts:
- add-card flow
- remaining secondary screens not yet shown
- final web layout polish
- final scanner implementation strategy
- exact edge cases for swipe gestures across all nested interactions

## Acceptance Criteria For Starting Implementation

Implementation can start now if the team follows these rules:

1. React Native app is built in parallel, not as a destructive rewrite.
2. Portfolio page is the first spike.
3. Fonts are integrated from the provided assets.
4. The current Looty token language is preserved.
5. Bottom nav, portfolio, detail, and sell layout rules in this document are treated as locked.
6. Scanner is not used as a reason to block the RN shell migration.

## Final Decision

There is enough information to begin the React Native migration for:
- app shell
- design system
- portfolio spike
- inventory/recent sales continuation
- later product detail + sell migration planning

There is **not** enough information yet to fully rebuild every remaining screen without more screenshot passes.

That is acceptable.

The migration should begin anyway with the portfolio-first approach.
