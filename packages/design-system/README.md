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
- sizes:
  - `sm`
  - `md`
  - `lg`
- label styles:
  - `control`
  - `body`
  - `bodyStrong`
  - `caption`
- optional `leadingAccessory`
- optional `trailingAccessory`

### IconButton

File: `src/components/icon-button.tsx`

Use for icon-only actions like back, close, or compact utility controls.

Current API concepts:

- variants:
  - `elevated`
  - `brand`
  - `ghost`

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

### StateCard

File: `src/components/state-card.tsx`

Use for loading, empty, retry, and unavailable states.

Current API concepts:

- title
- message
- optional loading indicator
- optional action button
- optional centered layout

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

- `typography.control`
- sizes:
  - `md`
  - `lg`
- tones:
  - `default`
  - `inverted`

### SegmentedControl

File: `src/components/segmented-control.tsx`

Use for mutually exclusive short option groups.

Current label role:

- `typography.control`

### FloatingBottomNav

File: `src/components/floating-bottom-nav.tsx`

Use for shared bottom navigation chrome.

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
