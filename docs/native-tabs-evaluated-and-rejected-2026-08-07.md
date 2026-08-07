# Native iOS 26 tabs — evaluated and rejected

> **STATUS: DECIDED 2026-08-07. Do not re-open without a new constraint.**
> Native tabs were built, run on device against the live app, and rejected. The
> custom bar stays. The spike routes have been deleted; this document is what
> remains, so the next person does not re-derive it.

Supersedes the tab-bar half of `docs/archive/ios26-liquid-glass-bars-2026-06-04.md`.

## Outcome

The bottom bar keeps its own implementation (`packages/design-system/src/components/bottom-tab-bar.tsx`
+ `apps/spotlight-rn/src/components/app-bottom-tab-bar.tsx`) driven by
`top-tabs-pager.tsx`. The one change kept from this exercise is **SF Symbol
glyphs** (`nav-tab-symbols.tsx`), which closed the entire perceived visual gap.

Side-by-side on device after that swap, the verdict was that they look the same.

## Why native tabs were rejected

Not taste — a hard constraint, found by reading the navigator rather than by
experiment.

**`NativeBottomTabsNavigator.js` emits `tabPress` and then dispatches `JUMP_TO`
unconditionally. It never reads `defaultPrevented`.** So a native tab item cannot
be intercepted to push a screen instead of switching to it. Two requirements fall
out of that and cannot be met:

1. **The Scan slot must push, not switch.** The camera is a full-screen
   experience with a back button, not a peer tab.
2. **The bar must not render on the Scanner.** If Scan is a native tab, UIKit
   draws the bar over it, applies automatic content insets, and the camera area
   shrinks. This was observed, not predicted: the scanner reticle visibly shrank
   on the spike, because reticle geometry comes from `useWindowDimensions()`
   (`scanner-screen.tsx:862-863`) — full-window math inside an inset container.

Native tabs also cannot swipe between tabs (`UITabBarController` has no such
gesture; confirmed absent from both `TabsHost.types.ts` and expo-router's props),
which would have cost the Portfolio ↔ Scanner pager.

## What the custom bar already does

Every behavioural requirement was already met before this exercise started. This
list exists because it was nearly rebuilt from scratch by mistake:

| Requirement | Where |
|---|---|
| Floating iOS 26 glass pill, not a full-width bar | `bottom-tab-bar.tsx:50` |
| Real `UIGlassEffect` (`glassEffectStyle="clear"`) | via `GlassSurface` |
| Minimize on scroll, collapsing to the active icon | `collapsed` prop |
| Collapsed pill pinned bottom-LEFT | `bottom-tab-bar.tsx:91-94` |
| Wired to real scroll | `portfolio-screen.tsx:744` → `useTabBarScrollHandler` |
| Absent on the Scanner (full-bleed camera) | `top-tabs-pager.tsx:334` |
| Scan pushes rather than switching | `app-bottom-tab-bar.tsx` `goToScan` |

**The material was never the gap.** The custom bar and the native bar both use
the same `UIGlassEffect`. The difference was the glyphs: hand-drawn Figma SVG
paths versus SF Symbols. Swapping those closed it.

## The trap this exercise walked into twice

`requireOptionalNativeModule` returns `null` identically for *"the module is not
in this binary"* and *"you asked for a name that does not exist."* Both look like
an out-of-date app and neither can be fixed by rebuilding.

- `expo-image-picker` registers **`ExponentImagePicker`**, not `ExpoImagePicker`.
  Photo upload and avatar change told every user to update an app that was
  already current, on builds that had the module all along.
- `expo-symbols` registers **`SymbolModule`**, not `ExpoSymbols` — that is the
  CocoaPod's name. The bar silently kept rendering its old glyphs and looked like
  the OTA had not landed.

The second happened one commit after the first was fixed and cited. A guard test
that mocks the probe and asserts the *render* does not catch it — it passes just
as happily against the wrong name. **Both probes now have tests that read the
name back out of the installed package** (`native-image-picker-test.ts`,
`nav-tab-symbols-test.tsx`). Any new native-module probe should do the same.

## If this is ever re-opened

It would take one of: expo-router honouring `defaultPrevented` on `tabPress`, a
UIKit API for a non-tab bar item, or a decision that the Scanner may live under
the tab bar and lose its full-bleed camera. Absent one of those, the answer is
unchanged.
