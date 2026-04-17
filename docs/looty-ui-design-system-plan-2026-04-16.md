# Looty UI Design System Plan

Date: 2026-04-16

## Why this is needed

The app already has multiple local mini-themes instead of one shared UI layer.

Examples:
- [ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- [PortfolioView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/PortfolioView.swift)
- [ShowsView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ShowsView.swift)

Today that means:
- colors are repeated as raw `Color(red:, green:, blue:)`
- spacing and corner radii drift by screen
- the same concepts like cards, pills, sheet surfaces, and CTA buttons are reimplemented per view
- tweaking brand color or surface treatment requires touching many feature files

## Goals

- Introduce one shared semantic theme layer for the app.
- Keep the current visual direction, but make it easier to change globally.
- Standardize the repeated components that already exist in scan, portfolio, detail, and selling flows.
- Migrate incrementally without a risky app-wide redesign.

## Non-goals

- This is not a full visual redesign.
- This is not a giant third-party component-kit migration.
- This does not replace native SwiftUI layout or interaction patterns.

## Recommended architecture

Create a local `LootyUI` layer inside the app, built on native SwiftUI.

Directory:
- `Spotlight/UI`

Core files:
- `LootyTheme.swift`
- `LootyComponents.swift`

Later expansion:
- `LootyFieldStyles.swift`
- `LootyMetrics.swift`
- `LootySheetChrome.swift`
- `LootyIcons.swift`
- `LootyPreviewGallery.swift`

## Token model

Use semantic tokens, not raw color names tied to one screen.

### Colors

- `canvas`
- `canvasElevated`
- `surface`
- `surfaceMuted`
- `surfaceLight`
- `field`
- `brand`
- `success`
- `warning`
- `danger`
- `textPrimary`
- `textSecondary`
- `textInverse`
- `outlineSubtle`
- `outlineStrong`

### Typography

- `display`
- `title`
- `titleCompact`
- `headline`
- `body`
- `bodyStrong`
- `caption`
- `micro`

### Spacing

Use a compact shared scale:
- `xxxs`
- `xxs`
- `xs`
- `sm`
- `md`
- `lg`
- `xl`
- `xxl`
- `xxxl`

### Radius

- `sm`
- `md`
- `lg`
- `xl`
- `pill`

### Shadows

Start with one shared shadow style and expand only if needed.

## Environment strategy

Provide `LootyTheme` through SwiftUI environment.

Why:
- easy global override
- easy preview override
- no singleton theme manager
- views can gradually adopt it without a big rewrite

Pattern:
- root injects `.lootyTheme(.default)`
- views read `@Environment(\\.lootyTheme)`

## First-pass components

The first shared components should map to patterns already repeated in the repo.

### 1. Surface wrapper

Use one shared surface modifier for:
- dashboard metric cards
- portfolio cards
- panel chrome
- compact info capsules

### 2. Primary button style

Use one shared style for:
- add to collection
- review sale
- portfolio primary CTAs

### 3. Secondary button style

Use for:
- less prominent actions
- tertiary control surfaces

### 4. Pill

Use for:
- filter chips
- condition pills
- status pills

### 5. Section header

Use for:
- repeated titled sections in portfolio and detail
- chart sections
- sheet subsections

## Rollout order

Keep the migration low-risk and visible.

### Phase 1: Tokens and scaffold

Land:
- theme
- environment hook
- a few shared styles

Adopt first in low-risk shared chrome:
- app shell bottom bar
- scanner banner

### Phase 2: Shared controls

Migrate:
- CTA buttons
- pills/chips
- card/surface wrappers
- section headers

Primary files:
- [ScannerView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerView.swift)
- [PortfolioView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/PortfolioView.swift)
- [ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
- [ShowsView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ShowsView.swift)

### Phase 3: Form and sheet system

Add:
- standardized text field chrome
- sheet headers
- bottom CTA area
- sell / buy / edit transaction field rows

This is where the current deal-flow views will benefit most.

### Phase 4: Preview gallery and regression

Add a component gallery view for:
- buttons
- pills
- surfaces
- field rows
- chart headers
- sheet chrome

Benefits:
- easier UI iteration
- easy screenshot regression
- safer future redesigns

## Migration rules

- No new feature view should introduce raw `Color(red:, green:, blue:)` if a semantic token already exists.
- No repeated CTA style should be reimplemented inline if a shared button style exists.
- New views should prefer tokenized spacing/radius over one-off numbers when the shared scale fits.
- Feature views can still own special-case layout, but not their own private theme unless there is a strong reason.

## What to migrate first in this repo

Highest-value targets:

1. `ShowsView`
- most UI complexity
- most repeated surface and field styling
- highest drift risk

2. `PortfolioView`
- chart card
- search/filter/sort row
- grid card styling
- selection surfaces

3. `ScanResultDetailView`
- CTA stack
- market value card
- collection row
- metadata pills

4. `ScannerView`
- tray rows
- helper pills
- pending/result cards

## First landed scaffold

The first pass now lives in:
- [LootyTheme.swift](/Users/stephenchan/Code/spotlight/Spotlight/UI/LootyTheme.swift)
- [LootyComponents.swift](/Users/stephenchan/Code/spotlight/Spotlight/UI/LootyComponents.swift)

Current adoption:
- app-root theme injection in [SpotlightApp.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/SpotlightApp.swift)
- shell and scanner banner usage in [ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)

## Suggested next implementation slice

If continuing immediately, the next best slice is:

1. move shared CTA button styling in `ScanResultDetailView` and `ShowsView` onto `LootyPrimaryButtonStyle`
2. standardize pills/chips across detail, portfolio, and scanner
3. replace the repeated local surface colors in `PortfolioView` and `ShowsView` with theme tokens
4. add a small preview gallery view for the new components

That will give the app a visibly more consistent UI without forcing a redesign.
