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
  - `xs` — 32px min height, 12/8 padding (compact form-footer action)
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
- `disabled` — filled variants (`primary` / `dark` / `accent` / `destructive`) collapse to the disabled token: a flat `gray400` (#BEBEBE) fill, white label, **no border** (Figma 3147:10840). Light/bordered variants keep a subtle premixed-alpha fade. (Borders are drawn transparent rather than as a translucent same-color ring, which used to composite into a dark outline.)

PDP usage: `<Button variant="outline" shape="rounded" labelStyleVariant="label" … />` and
`<Button variant="accent" shape="rounded" labelStyleVariant="label" … />`.

Edit-Profile footer usage (Figma 3083:12784):
`<Button variant="outline" shape="rounded" size="xs" labelStyleVariant="label" … />` paired with
`<Button variant="dark" shape="rounded" size="xs" labelStyleVariant="label" … />`.

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

### SearchEntryPill

File: `src/components/search-entry-pill.tsx`

Use for a top-bar search *entry point* — a pill that looks like a search field
but behaves as a button, opening a real search surface elsewhere. `SearchField`
stays the primitive for anything you actually type into.

Current API concepts:

- 44pt tall `gray50` pill with a 1pt `searchBorder` stroke at `radii.pill`,
  sized to match the 44pt `GlassNavBubble`s (`size="medium"`) beside it in the
  profile top bar (Figma 4299:94902)
- label role: `typography.bodySmall` in `gray600`, left-aligned
- `leading?: ReactNode` — optional badge at the leading edge (the app mark in the
  feed top bar). In flow, not absolute: badge and label are ONE group starting
  8pt in from the pill's left edge with 4pt between them, which is what the
  frame draws — the label is not centred in the full pill

### TextField

File: `src/components/text-field.tsx`

Use for reusable single-line form inputs.

Current API concepts:

- optional label
- optional helper text
- optional leading and trailing nodes
- RN `TextInput` props passthrough
- forwarded `ref` to the underlying `TextInput` (for `focus()` / `blur()`)
- `variant`:
  - `filled` (default) — rounded, tinted box; the standard form input
  - `underline` — no fill or box, just a bottom rule. For surfaces where the
    input IS the content rather than one row of a form (the New Collection name
    field, Figma 3357:9430)

### ScreenHeader

File: `src/components/screen-header.tsx`

Use for page-level headers and top chrome copy blocks.

Current API concepts:

- title
- optional subtitle
- optional eyebrow
- optional left and right accessories
- `layout`: `inline` (default) puts the accessories and title on one row;
  `stacked` gives the accessories a row of their own above a full-width title
  (Search Cards, the follower/following lists). Prefer `stacked` wherever the
  title can be long — inline splits the row three ways, so a long title wraps
  early against the accessories.
- optional `testID`, and `accessoryTestID` for the stacked accessory row

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
- optional handle (`showHandle`; when rendered it carries `testID="sheet-header-handle"`, so a surface with no dismiss gesture can assert the drag affordance is absent)
- optional leading accessory
- optional right accessory
- optional subtitle
- title style:
  - `titleStyleVariant`: `title` | `titleCompact`
  - `titleStyle`: a full `TextStyle` override that wins over the variant (e.g. `typography.titleXsmall` for a compact 14/600 sheet title)

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

Use for empty, retry, and unavailable states — outcomes the user reads or acts
on. For a transient "still fetching" placeholder that content will replace,
use `InlineLoader` instead: a bordered card reads as a result, not as progress.

Current API concepts:

- title
- message
- optional loading indicator
- optional action button
- optional centered layout

### EmptyStatePrompt

File: `src/components/empty-state-prompt.tsx`

Use for a first-run / nothing-here-yet state that is an **invitation** rather
than a reported outcome: centered art, one line of copy, and a low-emphasis
`PillButton` (`soft` tone) into the action that fills the surface. No card, no
title, no solid button.

Pick `StateCard` instead when the state is a RESULT the user reads or retries
(error, unavailable, "no cards match this filter") — that one wants a bordered
surface, a title, and a real Button.

Current API concepts:

- message (one short centered line)
- optional `illustration?: ReactNode` — brand mark or art above the copy
- optional actionLabel + onActionPress (renders the soft chip)
- optional `actionIcon?: ReactNode` — glyph before the chip label
- illustration and icon are caller-owned so app-specific art stays out of the
  design system

### InlineLoader

File: `src/components/inline-loader.tsx`

Use for in-place loading: a spinner over one line of secondary copy, with no
card, border, or fill. This is the default treatment while a list/section is
fetching.

Current API concepts:

- optional label (one short line, e.g. "Fetching posts")
- size (`small` default / `large`)

### SlabFrame

File: `src/components/slab-frame.tsx`

Use to render a graded card's image inside its slab case (Figma 2609:6812).

PSA, CGC, Beckett/BGS, and TAG render as PHOTOGRAPHIC composites (the Figma
slab mocks are photos of real slabs, not vectors): the card image sits under a
bundled photo of that grader's empty slab (`assets/slabs/*-slab-template.png`,
transparent card window and blanked label), and the label text (set/name/detail
lines, grade, per-grader grade descriptor like "GEM MT"/"GEM MINT"/"MINT",
PSA's `#number`, optional cert) is drawn over the photo's blank label areas.
Fonts scale with the measured slot height, so it works from the 50×80 list
thumbnail up to grid tiles; wide values auto-shrink instead of truncating.
Per-grader geometry lives in `SLAB_TEMPLATES` in `slab-frame.tsx`; templates
are built from straight-on slab photos (BGS subgrades stay blank — we don't
hold that data).

Unknown graders keep the vector frame: a light plastic-look case border with
the grader's label band on top (grader name/wordmark left, grade right).

Current API concepts:

- `grader` — the entry's own grader; PSA/CGC/BGS ("Beckett")/TAG → their
  photographic template; unknown → neutral vector frame, never breaks
- `grade` — the label's grade numeral (+ descriptor line when the grade maps
  to one)
- `certNumber` — optional; the label's cert line (graders that print one)
- `size`: `sm` (list-row thumbnail) or `md` (grid tile) — vector path only;
  the template path measures itself
- children = the card image (absolute-fill; it is positioned into the
  template's card window)

### EkalightWordmark

File: `src/components/ekalight-wordmark.tsx`

The Ekalight horizontal brand lockup — swirl mark + "ekalight" letterforms
(Figma 3686:58352 `Ekalight_Wordmark-purple`). Vector (react-native-svg), not a
bundled PNG, so it stays crisp at any size and recolors per surface. Rendered by
`AuthScreenLayout`, so it heads every auth screen (log in, sign up, change
password).

Current API concepts:

- `height` — points tall; width follows the lockup's fixed 104.726:32 ratio.
  Defaults to 32 (the Figma toolbar size)
- `color` — glyph fill; defaults to `purple500`, the brand purple the mark ships
  in. Override for dark or single-color surfaces
- the path data is exported verbatim from Figma — do not hand-edit it; re-export
  from the source node if the mark changes

### GraderWordmark

File: `src/components/grader-wordmark.tsx`

The branded grader logo mark (official PSA/CGC/Beckett/TAG assets). Currently
used in the design-system catalog; available for meta lines/PDP if wanted.

Current API concepts:

- `grader` — the entry's grader string, normalized case-insensitively. Known
  marks: `PSA`, `CGC`, `Beckett`/`BGS`, `TAG` (official logo assets bundled in
  `assets/graders/`, nominative use). The mark is ALWAYS the entry's own grader.
- `size`: `sm` (12px-tall mark, tile meta) or `md` (16px, list rows)
- unknown graders fall back to the grader name as bold text — never breaks
- also exports `psaGradeDescriptor(grade)` (PSA-ONLY descriptor map, 10 →
  `GEM-MT`) and `hasGraderWordmark(grader)`

### CardListRow

File: `src/components/card-list-row.tsx`

Use for horizontal card-list views like Wishlist and Collections — a thumbnail
on the left, name/meta/grade in the middle, and price/trend/quantity stacked on
the right.

Current API concepts:

- `imageUrl` (renders a "CARD" placeholder when null)
- `name` (bold, single line)
- `cardNumber` + `setName` (joined as `"{cardNumber} · {setName}"`)
- optional `gradeLabel` (e.g. `"PSA 10"` or `"Near Mint"`) — always plain text
- optional `grader` + `grade` — wraps the THUMBNAIL in the `SlabFrame` case
  (the grade text line stays `gradeLabel`); always the entry's own grader
- `marketPrice` + `currencyCode` (formatted via `Intl.NumberFormat`, defaults
  to USD; hidden when null)
- optional `trendChangePercent` — signed percent stacked directly under the
  price, Robinhood-style: `+2.26%` in green400 / `-2.26%` in red400 (14
  SemiBold; the sign carries the direction, no arrow). Callers pass the
  window-scoped change percent. Exactly 0 renders a gray600 `0.00%` ("tracked
  but flat" ≠ "no data"); null/non-finite hides the line. Penny guard: when
  `marketPrice < 1` the line is suppressed entirely (a −50% on $0.04 misleads;
  pennies aren't investment content)
- optional `sparkPoints` + `sparkTrendPct` — renders a 62×22 `PriceSparkline`
  between the name/set copy and the price column
  (`[thumb][name/set][sparkline][price + %]`); the sparkline tints by its
  OWN `sparkTrendPct` direction, independent of the percent line. Absent/empty
  → no sparkline, layout identical to before
- `quantity` (rendered as `"Qty: {n}"` at the bottom of the LEFT copy stack,
  under the grade/condition line; `showQuantity={false}` hides it)
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
  `graderLabel` + `gradeLabel` (slab) building the quality lines;
  `showQualityLine={false}` hides just the condition/grade TEXT while keeping
  the slab-case thumbnail frame (Wishlist, where copy-specific condition isn't
  shown)
- `priceLabel` (14 Bold; no day-change delta — removed per Figma 2489:6459)
- optional `trendChangePercent` — window-scoped percent stacked directly under
  the price in the price row's left stack: a 12px `ArrowUp`/`ArrowDown` icon +
  `+10.46%` (12 SemiBold) in green400/red400. Exactly 0 renders a gray600
  `0.00%` with NO arrow ("tracked but flat" ≠ "no data"); null/non-finite
  hides the line. Callers pass the shared trend-window expression (since-added
  or 30d)
- optional `marketPrice` — numeric price backing `priceLabel`, used only for
  the penny guard: `< 1` suppresses the trend line entirely (a −50% on $0.04
  misleads; pennies aren't investment content)
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

### PriceSparkline

File: `src/components/price-sparkline.tsx`

Tiny inline price-trend chart (line + soft gradient fill) used wherever a row
needs a Robinhood-style mini graph — `CardListRow` (collection/wishlist rows),
the PDP price-trend list, and the Insights performance table. Promoted from
`apps/spotlight-rn/src/features/cards/components` once it hit 3+ consumers.

Current API concepts:

- `points` — market-price series, oldest → newest (a single point or flat
  series draws a centered horizontal line; empty → an empty box of the same
  size so rows stay aligned)
- optional `trendPct` — percent change across the series; `>= 0` tints
  `green400`, `< 0` tints `red400` (defaults to green when omitted)
- optional `width`/`height` — defaults 62×22 (the list-row size)
- requires `react-native-svg` (already a package peer dependency)

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

- `typography.control` (`default` tone) / `typography.label` (`filter` tone) / `typography.bodyMedium` (`soft` tone)
- tones:
  - `default` — brand-yellow pill (chart range pills, filter modal)
  - `filter` — Collection/Insights chip row: white when inactive, solid gray900 with white label when selected
  - `soft` — borderless gray-50 chip at radius 8 used inside `EmptyStatePrompt` ("Scan to add"); a suggestion, not a toggle, so it ignores `selected`
- `leading?: ReactNode` — optional icon before the label (e.g. the Insights Likes heart / Price arrows); caller owns the icon color so it can follow `selected`

### SegmentedControl

File: `src/components/segmented-control.tsx`

Use for mutually exclusive short option groups.

Current label role:

- `typography.control`

### PageTabs

File: `src/components/page-tabs.tsx`

Use for the page-level tab bar that switches a profile or screen between views
(e.g. Collection / For Sale / Activity).

Current API concepts:

- centered, content-width tabs with a 40px gap (Figma 3184-17337) — not full-width `flex: 1` tabs
- active tab: `bodyMedium` / `textPrimary` with a 2px `textPrimary` underline hugging the label
- inactive tab: `body` / `textSecondary`, no underline
- a full-bleed `gray200` rail runs edge to edge under all tabs; the active underline shares its
  baseline and paints over it. The rail is **not** inset by the page gutter, so render `PageTabs`
  full-bleed rather than inside a horizontally padded wrapper.

### FloatingBottomNav

File: `src/components/floating-bottom-nav.tsx`

Use for shared bottom navigation chrome.

Current behavior:

- default surface uses a frosted/glass capsule shell with a soft selected segment treatment
- scanner surface keeps the tighter, darker scanner-specific treatment

### GlassSurface

File: `src/components/glass-surface.tsx`

A background shell that renders the real native iOS 26 "Liquid Glass" material
(`expo-glass-effect`'s `GlassView` / `UIGlassEffect`) when it is genuinely
available, and a plain solid `View` otherwise.

Current behavior:

- iOS 26 (device on iOS 26 **and** binary compiled with the Xcode-26 SDK) →
  real Liquid Glass material
- every other target (Android, iOS < 26, glass disabled via accessibility) →
  a solid `View` in the required `fallbackColor` prop — pass the surface's
  existing token color so the fallback is byte-identical to today's look
- deliberately has **no** `BlurView`/`rgba` branch: a frosted-blur knockoff
  reads as a non-native imitation (a prior attempt shipped that and was reverted)
- caller owns the shape (radius, size, overflow clip) via `style`
- `isLiquidGlassAvailable()` is re-exported here so screens can gate their own
  layout (e.g. pinning a header so content scrolls under the glass) without
  importing `expo-glass-effect` directly
- `glassEffectStyle` prop selects the material variant: `regular` (frosted,
  default) or `clear` (more transparent — content genuinely shows through;
  used by the floating `BottomTabBar` pill for the Reddit-style look, whose
  base is fully transparent on real glass so the material isn't backed by a
  solid fill)
- glass only appears via a fresh native build, never OTA

### GlassButtonGroup

File: `src/components/glass-button-group.tsx`

Two or more toolbar controls sharing ONE glass surface — the trailing
delete/share pair on card detail, and edit/share on your profile
(Figma 3686:55167, 3670:47454). Built on `GlassSurface`, so real iOS 26 Liquid
Glass, and a solid fallback everywhere else.

The point is that it is one surface, not two. Each control in its own bubble
reads as unrelated buttons that happen to sit next to each other; a single pill
reads as one set of actions, which is what they are.

- 40pt tall, `radii.pill`, `paddingHorizontal: 6`, `gap: 6` — level with
  `glassNavBubbleSizes.compact` and the 40pt search pill
- children should be 36pt and carry NO fill of their own — pass
  `IconButton variant="ghost"`. A filled child puts a circle inside a pill,
  which is the look this exists to remove. `glassButtonGroupControlSize`
  exports the 36 so callers do not hard-code it
- also valid with a SINGLE child: that is how a lone back button stays in the
  same material as the group opposite it, instead of one bar carrying two
  different chrome styles
- `fallbackColor` defaults to `canvasElevated` (white) — the SAME fallback
  `GlassNavBubble` uses, plus `shadows.card` when there is no real glass, since
  white on a white page needs a raised edge to be visible at all. It defaulted
  to `gray50` until 2026-08-11, which left Android drawing a white menu bubble
  beside a grey action pill on the Wishlist bar and a grey back/delete/share on
  card detail. Pass a colour explicitly for anything that is not a white page
  (the scanner does)
- `glassButtonGroupHeight`, `glassButtonGroupControlSize`,
  `glassButtonGroupPaddingHorizontal` and `glassButtonGroupGap` are the
  canonical compact grouped-toolbar geometry — `GlassNavBubbleGroup`'s
  `compact` size reads them rather than restating 6/6/36/40, because bar
  layouts are solved from those exact numbers and two copies could silently
  disagree

### GlassNavBubble

File: `src/components/glass-nav-bubble.tsx`

The shared floating circular nav button used by the Home top bar, the scanner
viewfinder, and the Wishlist header. Built on `GlassSurface`, so real
iOS 26 Liquid Glass (`regular` material) sits behind the glyph and everything
else gets a solid, honest fallback — never a blur/rgba imitation.

Props:

- `accessibilityLabel` (required), `children` (the glyph), `onPress`
- `size`: `'small'` (32pt — dense chrome over a live surface, e.g. the scanner),
  `'compact'` (40pt — a bubble sharing a compact top bar with other 40pt
  controls, e.g. the Wishlist header; the 8pt `hitSlop` carries it back over the
  44pt touch minimum), or `'medium'` (44pt, the default — the standalone
  floating bubble AND every control in the Home/profile top bar, Figma
  4299:94902)
  - **Match the bar you are in.** The Home/profile bar is a 44pt row
    (`medium`); the Wishlist bar is still a 40pt row (`compact`). A bubble 4pt
    taller than everything beside it is exactly what the Wishlist header once
    did next to its own `EditDoneButton`.
- `surface`: describes what is UNDERNEATH, not the glass material —
  `'onLight'` (default) or `'onDark'`
- `disabled`, `style` (positioning is caller-owned), `testID`
- `glassNavBubbleSizes` is exported so screens can lay bubbles out from the token
  (Collection offsets each corner bubble by `diameter + gap`)

Why `surface` instead of a raw `glassColorScheme`:

- `glassColorScheme="auto"` follows the SYSTEM light/dark setting, which says
  nothing about the backdrop. On the scanner the system can be in light mode
  while the camera feed is near-black, and a light material washes out into an
  opaque white puck.
- `onDark` therefore pins the material to `dark`; `onLight` keeps `auto`, because
  those bubbles sit beside UIKit's own native tab bar (system-driven glass we do
  not get to configure, so our chrome has to meet it).

Non-glass fallbacks (Android, iOS < 26, glass disabled for accessibility):

- `onLight` → solid `canvasElevated` circle with the `shadows.card` lift
- `onDark` → transparent fill with a 1pt `gray0` hairline ring and no shadow. A
  solid light circle would punch a bright hole in the viewfinder and hide the
  frame the user is aiming; there is also no lit surface for a shadow to fall on.

Icon color is never forced — the glyph is `children`, so callers pass `gray900`
on light surfaces and `gray0` on the scanner.

### GlassNavBubbleGroup

File: `src/components/glass-nav-bubble-group.tsx`

Several nav controls sharing ONE glass capsule — Home's trailing search + bell
pair (Figma 4299:94902: a single 104×44 capsule with 36pt symbol frames on a
20pt gap) and the profile toolbar's edit + share pair, i.e. Apple's iOS 26
grouped-toolbar pattern. **They are not two circles.**

- `items`: one entry per slot, left to right —
  `{ accessibilityLabel, children, onPress, disabled?, testID? }`. An ARRAY
  rather than `children`, so the primitive can size itself from the count and
  vary each slot's `hitSlop` by position; neither is possible with opaque
  children.
- `size`: `'compact'` (default) or `'medium'` — see the geometry below.
- `surface`: same meaning as on `GlassNavBubble` — what is UNDERNEATH, not the
  material. `'onLight'` (default) or `'onDark'`.
- `style` (layout is caller-owned), `testID`

Geometry, from `glassNavBubbleGroupSizes`:

- `compact` — 40pt tall, `paddingHorizontal: 6`, `gap: 6`, 36pt slots, read
  straight off `GlassButtonGroup`'s own 6/6/36/40 rather than restating them.
  `glassNavBubbleGroupMetrics` survives as an alias of this size.
- `medium` — 44pt tall, same 6pt padding and 36pt slots, but a 20pt gap
  (Figma 4299:94902), sitting level with `glassNavBubbleSizes.medium` bubbles.
- `glassNavBubbleGroupWidth(n, size?)` =
  `padding·2 + slot·n + gap·(n−1)` → **90 for two `compact` slots, 104 for two
  `medium` slots**, applied as an explicit `width`. The number is load-bearing:
  the profile toolbar closes at `16 + 44 + 8 + 197 + 8 + 104 + 16 = 393`, so
  the flexed `SearchEntryPill` only lands on its 197 if the trailing capsule is
  exactly 104.
- `hitSlop` is 8 on the OUTSIDE edges (matching a standalone `GlassNavBubble`)
  and 4 on the inside ones, which takes every 36pt slot over the 44pt touch
  minimum. On `compact` the 6pt seam between neighbours is therefore shared: a
  tap in its middle 2pt goes to the later slot. `medium`'s 20pt gap keeps the
  targets 12pt apart.

Why not `GlassButtonGroup`, which is the same shape:

- the fallback has to be `canvasElevated` + `shadows.card`, matching the
  `GlassNavBubble` at the other end of the same row; `GlassButtonGroup` falls
  back to a flat `gray50` with no lift, which beside a shadowed menu bubble
  reads as two chrome styles in one bar
- `overflow` must stay **visible** — Home's unread badge hangs off the bell at
  `top: -2, right: -2`, and `GlassButtonGroup` clips its material with
  `overflow: 'hidden'`
- it owns its pressables, so a slot's `hitSlop` can depend on whether it is on
  an outside edge; `GlassButtonGroup` takes arbitrary children and cannot know

Non-glass fallbacks are ONE capsule, never one chip per slot — `onLight` a solid
`canvasElevated` pill with the `shadows.card` lift, `onDark` a transparent pill
with a 1pt `gray0` ring. Nesting two fallback circles in a container is exactly
the "two circles in a box" look grouping exists to remove. Pressing dims the
SLOT, not the capsule, so the material never fades out from under a live
neighbour.

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
