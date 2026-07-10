# Spotlight React Native Design System

This package is the single source of truth for shared React Native design tokens and reusable UI primitives.

## Purpose

Use this package for:

- typography tokens
- color tokens
- spacing and radius tokens
- shared cards
- shared buttons
- shared icon buttons
- shared search fields
- shared text fields
- shared section headers
- shared sheet headers
- shared screen headers
- shared state cards
- other basic RN primitives that should stay visually uniform across screens

Do not use this package for:

- card-domain business logic
- scanner-only orchestration
- deeply app-specific composites that only make sense in one feature flow

Those should live in the RN app and compose the primitives from this package.

## Source Of Truth Files

- tokens: `src/tokens.ts`
- theme context: `src/theme.tsx`
- exports: `src/index.ts`
- primitives: `src/components/*.tsx`

## Current Tokens

Defined in `src/tokens.ts`:

- `fontFamilies`
- `colors`
- `spacing`
- `radii`
- `layout`
- `shadows`
- `textStyles`
- `MAX_FONT_SIZE_MULTIPLIER`

## Font Scaling Policy

iOS/Android Dynamic Type ("Larger Text") is **capped at `MAX_FONT_SIZE_MULTIPLIER` (1.2)**, not disabled — text still grows up to ~20% for accessibility but never blows up our fixed `fontSize` + baked-`lineHeight` layouts. The cap is applied globally at the app root (`apps/spotlight-rn/src/lib/text-scaling.ts` sets `Text`/`TextInput` `defaultProps.maxFontSizeMultiplier`) and is also set explicitly on the shared text primitives (`AppText`, `TextField`, `SearchField`). Precisely-measured elements that can't follow scaling (`RollingNumberText`, auth OTP cells) opt out with `allowFontScaling={false}`. To adjust the ceiling, change the single constant in `src/tokens.ts`.

Current typography roles:

- `display`
- `title`
- `titleCompact`
- `headline`
- `body`
- `bodyStrong`
- `control`
- `caption`
- `micro`

Current scanner surface tokens:

- `scannerCanvas`
- `scannerTray`
- `scannerSurface`
- `scannerSurfaceMuted`
- `scannerSurfaceStrong`
- `scannerOutline`
- `scannerOutlineSubtle`
- `scannerTextPrimary`
- `scannerTextSecondary`
- `scannerTextMuted`
- `scannerTextMeta`
- `scannerGlow`
- `scannerValuePill`

## Current Primitives

### Button

File: `src/components/button.tsx`

Use for standard actions.

Current API concepts:

- variants:
  - `primary`
  - `secondary`
  - `ghost`
  - `outline` — white card on a `gray200` (#E8E8E8) border with a `gray900` label (PDP secondary action)
  - `accent` — `purple500` (#A54BFA) fill with a white label (PDP ADD ITEM accent)
  - `dark` — `gray900` (#1A1A1A) fill with a white label (black commit CTA, e.g. Add-to-Collection CONFIRM)
  - `destructive` — `dangerStrong` (#D93025) fill with a white label (destructive CTA, e.g. bulk Remove)
- sizes:
  - `sm`
  - `md`
  - `lg`
- shape (defaults to `pill`):
  - `pill` — fully rounded (radius 999), the historical default
  - `rounded` — `radii.sm` (8) corners
- label styles:
  - `control`
  - `body`
  - `bodyStrong`
  - `caption`
  - `label` — 13px Medium (`typography.label`)
- optional `leadingAccessory`
- optional `trailingAccessory`

PDP usage: `<Button variant="outline" shape="rounded" labelStyleVariant="label" … />` and
`<Button variant="accent" shape="rounded" labelStyleVariant="label" … />`.

### IconButton

File: `src/components/icon-button.tsx`

Use for icon-only actions like back, close, or compact utility controls.

Current API concepts:

- variants:
  - `elevated`
  - `brand`
  - `ghost`
  - `outlined` (white fill, `gray300` hairline border — the Collection / Wishlist view toggle)
- `shape`: `circle` (default) or `rounded` (rounded square at `radii.sm`)

### SearchField

File: `src/components/search-field.tsx`

Use for reusable search inputs across inventory, catalog, and history surfaces.

Current API concepts:

- shared shell
- optional custom leading node
- RN `TextInput` props passthrough

### TextField

File: `src/components/text-field.tsx`

Use for reusable single-line form inputs.

Current API concepts:

- optional label
- optional helper text
- optional leading and trailing nodes
- RN `TextInput` props passthrough

### ScreenHeader

File: `src/components/screen-header.tsx`

Use for page-level headers and top chrome copy blocks.

Current API concepts:

- title
- optional subtitle
- optional eyebrow
- optional left and right accessories

### SectionHeader

File: `src/components/section-header.tsx`

Use for collapsible or action-bearing section headers.

Current API concepts:

- title
- optional subtitle
- optional count text
- optional right-side action
- optional collapse/expand interaction

### SheetHeader

File: `src/components/sheet-header.tsx`

Use for modal, sheet, or centered top-row headers where actions flank a title.

Current API concepts:

- align:
  - `leading`
  - `center`
- optional handle
- optional leading accessory
- optional right accessory
- optional subtitle
- title style:
  - `title`
  - `titleCompact`

### SheetSurface

File: `src/components/sheet-surface.tsx`

Use for the rounded-top surface of a bottom sheet (handle + padded body).

Current API concepts:

- optional handle
- tone:
  - `light` (white elevated sheet — default)
  - `dark` (gray-900 scanner sheet shown over the camera)

### RadioDot

File: `src/components/radio-dot.tsx`

Use for single-select option indicators in lists and sheets (e.g. the scanner
"Scanning for" sheet). Selected = white dot with a colored ring and center (the
brand lilac by default, or `selectedColor`); unselected = light filled circle
with a gray-300 ring.

Current API concepts:

- selected
- optional size (defaults to 16; the inner dot is ~0.625× when selected)
- tone (sets the unselected fill so the dot reads on its surface):
  - `light` (white fill for light surfaces)
  - `dark` (gray-50 fill so it reads on the dark scanner sheet)
- optional `selectedColor` — overrides the selected ring + inner-dot color
  (defaults to the brand lilac). The scanner "Scanning for" sheet passes
  `colors.purple500` to match the Figma radio.

### Toast

File: `src/components/toast.tsx`

Lightweight, auto-dismissing transient message. Controlled via `visible`; fades
in, calls `onDismiss` after `durationMs`, then fades out. Optionally tappable as
a single primary action (e.g. the scanner's "looks like a Japanese card — tap to
switch" notice). Layout-agnostic — the consumer positions it via `style`.

Current API concepts:

- visible / message
- optional onPress (tappable primary action) + actionAccessibilityLabel
- onDismiss (fires on timeout or × tap)
- optional durationMs (defaults to 6000; 0 disables auto-dismiss)
- optional showDismiss (the × affordance; defaults to true)
- tone:
  - `dark` (default; reads over the camera)
  - `light` (elevated surface)
  - `warning` (yellow background, near-black text — for soft alerts like wrong-toggle scans)

### StateCard

File: `src/components/state-card.tsx`

Use for loading, empty, retry, and unavailable states.

Current API concepts:

- title
- message
- optional loading indicator
- optional action button
- optional centered layout

### CardListRow

File: `src/components/card-list-row.tsx`

Use for horizontal card-list views like Wishlist and Collections — a thumbnail
on the left, name/meta/grade in the middle, and price/trend/quantity stacked on
the right.

Current API concepts:

- `imageUrl` (renders a "CARD" placeholder when null)
- `name` (bold, single line)
- `cardNumber` + `setName` (joined as `"{cardNumber} · {setName}"`)
- optional `gradeLabel` (e.g. `"PSA 10"` or `"Near Mint"`)
- `marketPrice` + `currencyCode` (formatted via `Intl.NumberFormat`, defaults
  to USD; hidden when null)
- optional `trendChangeAmount` (positive → green up arrow, negative → red down
  arrow, null/0 → hidden)
- `quantity` (rendered as `"Qty: {n}"`)
- optional `onPress` (whole row becomes a `Pressable` with button role)

### InventoryCardTile

File: `src/components/inventory-card-tile.tsx`

Use for card-grid ("card view") tiles wherever a card is shown with its art,
identity, quality, and price — the Collection card view and the Wishlist card
view both render this same tile so the two stay pixel-identical. Do not
hand-roll grid tiles in screens.

Current API concepts:

- `imageUrl` (art fills the column width inside a square frame at the card's
  real aspect ratio; "CARD" placeholder when null)
- `name`, `setName` + `cardNumber` (joined as `"{cardNumber} · {setName}"`)
- `kind` (`'raw' | 'slab'`) with `variantName`, and `conditionLabel` (raw) or
  `graderLabel` + `gradeLabel` (slab) building the quality lines
- `priceLabel` (14 Bold; no day-change delta — removed per Figma 2489:6459)
- `quantity` readout at the right edge of the price row (count + box icon);
  `showQuantity={false}` hides it for surfaces with no owned-quantity concept
  (Wishlist card view)
- `isFavorite` star badge top-right; `showFavorite={false}` hides it (both
  card views); `selectable`/`selected` swaps the badge slot for a selection
  check-circle in multi-select edit mode
- `bordered={false}` renders the "plain" tile for full-bleed ruled grids where
  the container draws the dividers (both card views)
- optional `liveOnEbay` footer with `onOpenListing`
- `onPress`, optional `onLongPress` + `delayLongPress`

### ListPaginationFooter

File: `src/components/list-pagination-footer.tsx`

Footer for long list views (Collection / Wishlist) that page in 10 rows at a
time per Figma node 669-8499.

Current API concepts:

- `canViewMore` (renders the gray `gray100` "View More" pill that reveals the
  next page; hide once every row is visible)
- `onViewMore` (reveal-next-page handler)
- optional `onBackToTop` (renders the up-chevron "Back to top" affordance)
- optional `viewMoreLabel` (defaults to `"View More"`)
- renders nothing when `!canViewMore && !onBackToTop`

### ScrollToTopButton

File: `src/components/scroll-to-top-button.tsx`

Floating "Back to top" button per Figma node 1252-1335: a 40x40 `gray100`
rounded (`radii.sm`) square with a `gray800` up arrow. Meant to appear once the
user scrolls past the initial viewport and scroll the list back to the top on
press.

Current API concepts:

- `visible` (fades / slides the button in or out; while hidden it is
  `pointerEvents: 'none'` so it never blocks touches)
- `onPress` (scroll-to-top handler)
- optional `accessibilityLabel` (defaults to `"Back to top"`)
- optional `style` — the consumer owns absolute positioning (e.g. the app's
  `ScrollToTopFab` stacks it above the `+` add FAB) and scroll tracking

### SurfaceCard

File: `src/components/surface-card.tsx`

Use for elevated surfaces and container shells.

Current API concepts:

- variants:
  - `elevated`
  - `muted`
  - `field`

### PillButton

File: `src/components/pill-button.tsx`

Use for compact single-action chips and option toggles.

Current label role:

- `typography.control` (`default` tone) / `typography.label` (`filter` tone)
- tones:
  - `default` — brand-yellow pill (chart range pills, filter modal)
  - `filter` — Collection/Insights chip row: white when inactive, solid gray900 with white label when selected
- `leading?: ReactNode` — optional icon before the label (e.g. the Insights Likes heart / Price arrows); caller owns the icon color so it can follow `selected`

### SegmentedControl

File: `src/components/segmented-control.tsx`

Use for mutually exclusive short option groups.

Current label role:

- `typography.control`

### FloatingBottomNav

File: `src/components/floating-bottom-nav.tsx`

Use for shared bottom navigation chrome.

Current behavior:

- default surface uses a frosted/glass capsule shell with a soft selected segment treatment
- scanner surface keeps the tighter, darker scanner-specific treatment

## Design-System Editing Rules

- Prefer editing tokens or shared primitives before patching individual screens.
- Interactive labels should use `typography.control` by default unless a control is intentionally demoted into helper/meta text.
- Scanner UI is not a free-form exception. Distinct scanner surfaces should still consume shared scanner tokens and reusable primitives where possible.
- If the same visual pattern appears in multiple screens, consider whether it should move into this package.
- Prefer named props like `variant`, `size`, and `labelStyleVariant` over repeated inline style overrides.
- Avoid adding new direct `fontWeight` or `fontFamily` overrides in screens when a token or primitive can express the same intent.
- If a primitive changes in a user-visible way, update the highest-value RN tests that cover the screens using it.

## Claude-Friendly Structure

This package is intentionally structured so Claude Code can understand it quickly:

- all exports are centralized in `src/index.ts`
- all tokens live in one file
- each primitive lives in one file
- prop names are descriptive and variant-driven
- higher-level guidance lives in:
  - `docs/rn-design-system-audit-2026-04-26.md`
  - `docs/claude-design-system-integration-2026-04-26.md`

## Live Catalog

The RN app includes a hidden design-system catalog route for visual review and prompt-grounding:

- route file: `apps/spotlight-rn/src/app/(stack)/design-system.tsx`
- screen file: `apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx`

Use that screen to inspect:

- typography roles
- current token values
- shared primitive states
- visual drift before changing production screens

## Prompt Template

When asking Claude to modify the design system, prefer a prompt shaped like:

```xml
<task>Adjust the shared RN button primitive and migrate the affected screens.</task>
<affected_tokens>typography.bodyStrong, colors.brand</affected_tokens>
<affected_primitives>Button, IconButton</affected_primitives>
<affected_screens>portfolio, inventory, sales history</affected_screens>
<constraints>Preserve existing screen behavior except for the requested visual cleanup.</constraints>
<acceptance>Use shared primitives, update tests, and avoid screen-local style drift.</acceptance>
```

For design ingestion from Figma or Claude-connected design tooling, include:

```xml
<design_source>Figma Dev Mode MCP</design_source>
<mapping_goal>translate repeated visual patterns into shared RN primitives</mapping_goal>
<token_policy>prefer token changes before one-off screen edits</token_policy>
```
