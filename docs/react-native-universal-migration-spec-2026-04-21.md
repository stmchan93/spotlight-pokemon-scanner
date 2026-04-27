# React Native Mobile Migration Brief

Date: 2026-04-21

## Status

- This document is the locked source of truth for React Native design-parity and UI-architecture planning.
- Scope is `iOS + Android first`.
- Web is explicitly deferred until after the mobile shell and the first core screens are approved.
- The Python backend stays intact.
- The current SwiftUI iOS app stays in production in parallel during the migration.
- This brief supersedes the earlier broader "universal app now" framing for active planning.

## Locked Product Decisions

- Do not rewrite the backend.
- Do not replace the current production SwiftUI iOS app during the first React Native spike.
- Do build the React Native app as a parallel client surface while parity is being proven.
- Do not front-load scanner porting work into the first React Native spike.
- Do not treat web as part of phase 1 acceptance.
- Do not let the migration drift into a generic Expo, Material, or system-default redesign.

## Primary Goal

Build a React Native mobile shell that can match the current product's visual quality at pixel-close or better fidelity on iPhone-class layouts while remaining portable to Android.

The first approved spike is:

- `Portfolio` page only

That spike is the proving ground for:

- typography
- spacing
- shell chrome
- density controls
- inventory-card treatment
- recent-sales module
- navigation emphasis

## Explicit Non-goals For The First Spike

- no backend changes
- no scanner parity work
- no OCR or camera migration
- no web layout work
- no redesign exploration beyond the user-locked rules below
- no additional tabs beyond `Portfolio` and `Scan`

## Why Portfolio Is The First React Native Spike

- It is the highest-value non-scanner surface in the current product.
- It exercises the shared shell without forcing scanner-native decisions too early.
- It covers the biggest reusable design primitives:
  - large-title typography
  - floating bottom navigation
  - card tiles
  - section headers
  - list rows
  - spacing rhythm
  - light-surface treatment
- It gives a clean base for the next likely screens:
  - product detail
  - sell

Do not use the scanner screen as the first React Native spike.

## Locked Success Bar

- The first React Native Portfolio screen must be pixel-close or better against the approved references.
- "Close enough" is not acceptable if the result looks like a generic React Native port.
- The React Native shell may improve polish, but it may not degrade the current product personality.
- The spike must prove that the design language survives React Native before more feature scope is approved.
- The current SwiftUI iOS app must remain shippable and unchanged in production during this proof.

## Locked Design Rules

### App shell

- Mobile bottom navigation is a floating `72px` bar.
- Tabs are limited to:
  - `Portfolio`
  - `Scan`
- `Scan` must be visually dominant over `Portfolio`.
- The nav must feel like product chrome, not a stock tab bar.
- The shell must preserve the current black-scanner vs light-portfolio mode split.

### Typography

- Use `Special Gothic Expanded One` for:
  - large titles
  - major section headers
  - screen titles
- Use `Outfit` for:
  - body
  - caption
  - supporting UI copy
- Do not use a system-font fallback as the approved design direction.
- Lock type usage behind tokens from day one so both iOS and Android render the same hierarchy.

### Portfolio page

- horizontal page margins: `16px`
- section spacing: `32px`
- density toggle options:
  - `2`
  - `3`
  - `4`
  - `5`
- default density: `3`
- Recent Sales rules:
  - maximum `9` rows
  - row height `96px`
  - row internal padding `8px`
  - chevron sits next to the section title
  - `View all` is right-aligned in the section header

### Product detail

- Replace the current neutral detail hero with a sell-gradient hero.
- Remove metadata chips from the approved React Native detail direction.
- Remove the top-left standalone price treatment from the hero.
- Keep the detail screen focused on card identity plus selling context, not chip clutter.

### Sell screen

- top spacing above primary content: `40px`
- horizontal margins: `16px`
- card number must sit next to the card name in the title block
- include a camera thumbnail field
- swipe-to-sell must require `>= 50%` progress before release-to-confirm state is allowed

### Scanner shell screenshot lock

The user-provided scanner shell screenshot is a locked reference for shell tone and hierarchy.

Treat these screenshot-derived rules as fixed:

- the shell stays visually minimal
- the scanner route stays black and immersive
- the floating bottom nav sits above the shell rather than behaving like a docked stock tab bar
- the scan affordance is the dominant control in the shell
- no extra tab destinations are added during the first spike

If exact radii, offsets, or icon sizing are missing from code, take them from the approved screenshot/reference export before implementation. Do not invent new shell chrome.

## Source Surfaces To Match

The React Native spike should preserve the current product language from these files:

- portfolio:
  - [PortfolioView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/PortfolioView.swift)
- scanner shell:
  - [ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
  - [ScannerView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerView.swift)
- detail:
  - [ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
- sell:
  - [SellOrderSheets.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/SellOrderSheets.swift)
  - [SellModalComponents.swift](/Users/stephenchan/Code/spotlight/Spotlight/UI/SellModalComponents.swift)

These are parity references, not implementation templates.

## UI Architecture Lock

The React Native app should be organized as a parallel mobile client with a thin boundary to the existing backend.

Recommended shape:

- app shell:
  - two-tab mobile shell only
- theme:
  - tokens
  - typography
  - colors
  - spacing
  - radius
- features:
  - portfolio
  - detail
  - sell
- platform boundary:
  - scanner remains a later native-first problem

Recommended module skeleton:

- `rn/app/(tabs)/portfolio.tsx`
- `rn/app/(tabs)/scan.tsx`
- `rn/app/card/[id].tsx`
- `rn/app/sell/[id].tsx`
- `rn/src/theme/tokens.ts`
- `rn/src/theme/typography.ts`
- `rn/src/components/shell/FloatingBottomNav.tsx`
- `rn/src/components/typography/ScreenTitle.tsx`
- `rn/src/components/portfolio/DensityToggle.tsx`
- `rn/src/components/portfolio/RecentSalesRow.tsx`
- `rn/src/components/detail/SellGradientHero.tsx`
- `rn/src/components/sell/SwipeSellRail.tsx`
- `rn/src/lib/api/`

## React Native Primitive Requirements

The first spike should create reusable primitives instead of hardcoding one screen:

- `FloatingBottomNav`
- `ScreenTitle`
- `SectionHeader`
- `DensityToggle`
- `CardTile`
- `RecentSalesRow`
- `SellGradientHero`
- `CameraThumbnailField`
- `SwipeSellRail`

## Delivery Order

### Phase 1: shell + typography + tokens

- load fonts
- lock typography tokens
- build floating bottom nav
- build light/dark shell split

### Phase 2: Portfolio spike

- page header
- density toggle
- inventory presentation at default density `3`
- Recent Sales section
- screenshot QA pass

### Phase 3: detail and sell follow-on

- detail hero update
- chip removal
- sell screen title block update
- camera thumbnail field
- swipe threshold lock

## Acceptance For Approval

- Portfolio is the first React Native spike page.
- The bottom nav is floating, `72px`, and limited to `Portfolio` plus `Scan`.
- `Scan` is visually dominant.
- `Special Gothic Expanded One` and `Outfit` are wired and visible in the approved hierarchy.
- Portfolio uses `16px` margins and `32px` section rhythm.
- Density toggle exposes `2/3/4/5` and defaults to `3`.
- Recent Sales respects the locked row, padding, count, and header rules.
- Detail and sell follow-on work uses the locked hero, chip-removal, spacing, and swipe rules above.
- No scope drift to backend, scanner migration, or web.

## Recommendation

Approve React Native only as a parallel, mobile-first UI-parity program.

Approve the first implementation spike only if it starts with:

- `Portfolio`

Do not approve:

- scanner-first React Native work
- web-first React Native work
- a redesign disguised as migration
- replacing the production SwiftUI iOS app before parity is proven
