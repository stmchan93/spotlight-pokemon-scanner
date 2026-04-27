# React Native Design System Audit

Date: 2026-04-26

This document is the Phase 1 audit for the React Native app UI layer.

## Scope

- repo surface:
  - `apps/spotlight-rn`
  - `packages/design-system`
- goal:
  - identify the current design-system surface
  - identify where visual drift is coming from
  - define the Phase 2 refactor target for basic building blocks

## Executive Summary

- The app does have a design system, but it is currently a thin local package, not a full component system.
- There is no third-party UI library in use.
- The current package is token-first and primitive-light:
  - theme provider
  - typography/color/spacing/radius/layout/shadow tokens
  - `SurfaceCard`
  - `PillButton`
  - `SegmentedControl`
  - `FloatingBottomNav`
- Most of the visual drift is not coming from the theme tokens. It is coming from screens bypassing shared primitives and rebuilding buttons, headers, search fields, state cards, and typography locally.
- Recommendation:
  - keep the current in-house design-system package
  - do not introduce a new external UI kit right now
  - expand the shared primitive set and migrate the most repeated surfaces first

## Current Stack

The RN app is built with:

- `react-native`
- `expo`
- `expo-router`
- `@react-navigation/native`
- `react-native-safe-area-context`
- `react-native-gesture-handler`
- `react-native-svg`
- `expo-blur`

Relevant files:

- [apps/spotlight-rn/package.json](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/package.json:1)
- [packages/design-system/package.json](/Users/stephenchan/Code/spotlight/packages/design-system/package.json:1)

There is no React Native Paper, Tamagui, NativeBase, UI Kitten, or similar component library in the repo.

## Current Design-System Surface

Current exports from `@spotlight/design-system`:

- `FloatingBottomNav`
- `PillButton`
- `SegmentedControl`
- `SurfaceCard`
- `SpotlightThemeProvider`
- token exports

Source:

- [packages/design-system/src/index.ts](/Users/stephenchan/Code/spotlight/packages/design-system/src/index.ts:1)

### Theme Tokens

The current token layer is defined in:

- [packages/design-system/src/tokens.ts](/Users/stephenchan/Code/spotlight/packages/design-system/src/tokens.ts:3)

Current token categories:

- `fontFamilies`
- `colors`
- `spacing`
- `radii`
- `layout`
- `shadows`
- `typography`

Current typography roles:

- `display`
- `title`
- `titleCompact`
- `headline`
- `body`
- `bodyStrong`
- `caption`
- `micro`

### Global Font Wiring

The app globally loads and uses:

- `SpotlightDisplay`
- `SpotlightBodyRegular`
- `SpotlightBodyMedium`
- `SpotlightBodySemiBold`
- `SpotlightBodyBold`

Source:

- [apps/spotlight-rn/src/app/_layout.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/app/_layout.tsx:38)

## Current Shared Components

Components currently inside `packages/design-system/src/components`:

- `floating-bottom-nav.tsx`
- `pill-button.tsx`
- `segmented-control.tsx`
- `surface-card.tsx`

Sources:

- [packages/design-system/src/components/floating-bottom-nav.tsx](/Users/stephenchan/Code/spotlight/packages/design-system/src/components/floating-bottom-nav.tsx:1)
- [packages/design-system/src/components/pill-button.tsx](/Users/stephenchan/Code/spotlight/packages/design-system/src/components/pill-button.tsx:1)
- [packages/design-system/src/components/segmented-control.tsx](/Users/stephenchan/Code/spotlight/packages/design-system/src/components/segmented-control.tsx:1)
- [packages/design-system/src/components/surface-card.tsx](/Users/stephenchan/Code/spotlight/packages/design-system/src/components/surface-card.tsx:1)

Shared UI that already exists but is not in the package:

- `ChromeBackButton`

Source:

- [apps/spotlight-rn/src/components/chrome-back-button.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/components/chrome-back-button.tsx:1)

## Audit Findings

### 1. The package is too small for the current app surface

The design system currently provides only 4 visual primitives. That is not enough for the number of distinct screens now in the RN app.

Missing core primitives:

- canonical button
- canonical icon button
- canonical screen header
- canonical section header
- canonical search field
- canonical text field
- canonical state card
- canonical sheet header / sheet scaffold

### 2. Screen-local controls are the main source of inconsistency

Current RN tree counts from local audit:

- raw `Pressable` usage: `60`
- raw `TextInput` usage: `8`
- direct `fontWeight` overrides: `25`
- direct `fontFamily` overrides: `19`

These are not automatically bad, but at the current scale they are a strong signal that too many base interactions are being rebuilt per screen.

### 3. Repeated patterns are duplicated under different local names

Examples:

- back/header buttons:
  - [apps/spotlight-rn/src/components/chrome-back-button.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/components/chrome-back-button.tsx:1)
  - local `HeaderButton` in [inventory-browser-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/inventory/screens/inventory-browser-screen.tsx:54)
  - local `HeaderButton` in [sales-history-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/portfolio/screens/sales-history-screen.tsx:54)
- state cards:
  - `SearchStateCard` in [catalog-search-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/catalog/screens/catalog-search-screen.tsx:41)
  - `AddStateCard` in [add-to-collection-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/collection/screens/add-to-collection-screen.tsx:47)
  - `EmptyStateCard` in [inventory-browser-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/inventory/screens/inventory-browser-screen.tsx:82)
  - `EmptyStateCard` in [sales-history-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/portfolio/screens/sales-history-screen.tsx:84)
- search fields:
  - inventory inline search in [inventory-grid.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/portfolio/components/inventory-grid.tsx:160)
  - catalog search field in [catalog-search-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/catalog/screens/catalog-search-screen.tsx:398)
  - inventory browser search in [inventory-browser-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/inventory/screens/inventory-browser-screen.tsx:284)
  - sales history search in [sales-history-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/portfolio/screens/sales-history-screen.tsx:278)
- sheet/form rows:
  - shared sell form is moving in the right direction in [sell-ui.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/sell/components/sell-ui.tsx:1)
  - add-to-collection still has its own row and chip treatment in [add-to-collection-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/collection/screens/add-to-collection-screen.tsx:92)

### 4. Typography drift is real

The token layer already defines usable typography roles, but many screens still override them directly.

Examples:

- inventory action labels override weight locally in [inventory-grid.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/portfolio/components/inventory-grid.tsx:217)
- catalog result titles/subtitles use local sizing/weight in [catalog-search-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/catalog/screens/catalog-search-screen.tsx:503)
- sell status screens use direct `fontWeight` values in [single-sell-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/sell/screens/single-sell-screen.tsx:758)
- card detail eBay wordmark uses custom text styling in [card-detail-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx:1004)

This is the clearest root cause behind “some buttons are bold, some are not” and “some fonts feel slightly different.”

### 5. The app has compositions, but not enough canonical ownership boundaries

Right now there are 3 layers mixed together:

- global tokens in `@spotlight/design-system`
- app-level shared pieces in `apps/spotlight-rn/src/components`
- screen-local primitives embedded inside feature screens

That makes it unclear where a new shared component should live, so many screens default to local implementation.

## What Should Be Shared In Phase 2

### Keep In `@spotlight/design-system`

Foundational primitives that should be available anywhere in the RN app:

- `Button`
  - variants:
    - `primary`
    - `secondary`
    - `ghost`
    - `danger` if needed
  - sizes:
    - `sm`
    - `md`
    - `lg`
- `IconButton`
  - back button
  - close button
  - circular icon-only actions
- `SearchField`
  - optional leading icon
  - consistent height, radius, border, placeholder style
- `TextField`
  - single-line form inputs
- `StateCard`
  - title
  - body copy
  - optional action area
  - optional loading treatment
- `SectionHeader`
  - title
  - optional count
  - optional chevron
  - optional right action
- `ScreenHeader`
  - title
  - subtitle optional
  - left control
  - right control
- `SheetHeader`
  - title
  - subtitle optional
  - dismiss/back action

### Keep App-Local, But Shared

Domain-specific compositions that should stay in the app, not the package:

- card-market modules
- sell swipe rail
- collection line items
- scanner tray chrome
- inventory tile cards

These should compose the design-system primitives instead of defining their own base controls.

## Proposed Ownership Rule

- `packages/design-system`
  - tokens
  - base typography roles
  - foundational reusable controls
- `apps/spotlight-rn/src/components`
  - app-wide composites built from those controls
- `apps/spotlight-rn/src/features/*`
  - domain-specific layout and behavior only
  - avoid screen-local base buttons, headers, state cards, and fields unless there is a real one-off reason

## Phase 2 Migration Order

### Batch 1: Highest-value primitives

Build first:

- `Button`
- `IconButton`
- `SearchField`
- `StateCard`
- `SectionHeader`
- `ScreenHeader`

These primitives will remove the most duplication with the least product risk.

### Batch 2: Highest-traffic screens

Migrate first:

- portfolio
- inventory browser
- sales history
- catalog search / add card
- add to collection

Reason:

- these screens have the most obvious repeated headers, actions, search inputs, and state cards
- they are visually central to the product

### Batch 3: Sell surfaces

Migrate next:

- single sell
- bulk sell
- sell shared form rows where appropriate

Reason:

- these screens already have partial consolidation in `sell-ui.tsx`
- they still contain local typography/action drift

### Batch 4: Detail and account/auth cleanup

Migrate next:

- card detail
- account
- sign-in / onboarding

### Batch 5: Scanner exceptions

Leave scanner until later unless there is a specific issue to fix.

Reason:

- scanner is intentionally more custom
- it should share typography and button primitives where it makes sense, but it should not be over-normalized into generic page UI too early

## Phase 2 Acceptance Criteria

The Phase 2 refactor should aim for the following:

- no repeated local `HeaderButton` implementations
- no repeated local state-card implementations
- no repeated inline search-field shells
- action buttons across portfolio, inventory, catalog, collection, and sell screens come from one canonical button primitive
- back/close controls come from one canonical icon-button primitive
- most text weight differences come from shared typography roles, not ad hoc `fontWeight` overrides
- direct style overrides still exist where intentionally needed, but are the exception rather than the default path

## Recommended First Implementation Slice

The smallest high-value Phase 2 slice is:

1. create:
   - `Button`
   - `IconButton`
   - `SearchField`
   - `StateCard`
   - `SectionHeader`
2. migrate:
   - `portfolio/components/inventory-grid.tsx`
   - `features/inventory/screens/inventory-browser-screen.tsx`
   - `features/portfolio/screens/sales-history-screen.tsx`
   - `features/catalog/screens/catalog-search-screen.tsx`
3. then review typography drift again before touching sell and scanner surfaces

## Decision

Proceed with Phase 2 by expanding the existing in-house `@spotlight/design-system` package.

Do not switch to a new external UI library during this cleanup. The current issue is not lack of a library. It is lack of enough shared primitives and lack of consistent ownership.
