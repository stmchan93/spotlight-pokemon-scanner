# Native iOS 26 tabs — adoption

> **STATUS: SUPERSEDED 2026-08-11 by [navigation-ia-2026-08-11.md](/Users/stephenchan/Code/spotlight/docs/navigation-ia-2026-08-11.md).**
>
> This doc describes a TWO-tab shape (Collection and Wishlist, Scan not a tab)
> that the app moved past within days: Scan became a real tab, and Home (the
> feed) and You were added, giving Home / Scan / Wishlist / You. Kept for the
> reasoning it records — why native tabs were adopted, why Scan cannot push
> instead of switch, and the reticle-inset finding — but do NOT read its
> structure as current.

Supersedes the tab-bar half of `docs/archive/ios26-liquid-glass-bars-2026-06-04.md`.

## The shape

**Two native tabs — Collection and Wishlist. Scan is not a tab.** It is a pushed
full-screen route (`/native-scan`).

That is not a compromise, it is what the constraints allow and it happens to be
better on the camera:

| | As a native tab | As a pushed route |
|---|---|---|
| Bar over the viewfinder | yes | no |
| Reticle size | shrunk by content insets | full |
| Way back | tab switch | back button + native drag-follow swipe |

## Why Scan cannot be a tab

Two constraints, both read out of source rather than inferred:

1. **`NativeBottomTabsNavigator` dispatches `JUMP_TO` without reading
   `defaultPrevented`.** It emits `tabPress` first, but ignores the result — so a
   native tab item can never be intercepted to push a screen instead of
   switching to it.
2. **A native tab always renders the bar over its screen** and applies automatic
   content insets. Observed on the spike, not predicted: the reticle visibly
   shrank, because its geometry comes from `useWindowDimensions()`
   (`scanner-screen.tsx:862-863`) — full-window math inside an inset container.

Native tabs also cannot swipe between tabs (absent from both
`TabsHost.types.ts` and expo-router's props; `UITabBarController` has no such
gesture). Losing the Portfolio ↔ Scanner swipe was accepted; the stack's back
gesture gives a real drag-follow swipe out of the camera, which covers most of
what that gesture was for.

## Files

- `src/app/native-tabs/_layout.tsx` — `NativeTabs`, `minimizeBehavior="onScrollDown"`
- `src/app/native-tabs/index.tsx` — Collection + the floating Scan button
- `src/app/native-tabs/wishlist.tsx` — Wishlist, promoted from a pushed screen to a tab
- `src/app/native-scan.tsx` — the camera, ROOT-level so it is never a tab
- `src/components/native-tabs-page-bridge.tsx` — maps navigation focus to `TabsPageContext`

**The bridge is load-bearing.** In the pager both screens are mounted
permanently, so `activePage` is the only signal telling each one it is live:
`scanner-screen.tsx:879` gates `shouldMountCamera` on it, and
`use-portfolio-screen-model.ts:447` gates inventory loading. Native tabs keep
screens mounted too, so the question survives and just gets a better answer —
real focus.

The Scan button lives in the route file rather than in `PortfolioScreen`, so the
shared screen doesn't grow a second scan affordance while both shells exist. If
this wins, it moves into the screen.

## Still open before the default can flip

| Behaviour | Where it lives now | Note |
|---|---|---|
| Left-edge swipe opens the drawer | `top-tabs-pager.tsx:194-200` | Inside the pager's pan responder — **disappears with it** |
| Hide the bar during Collection edit mode | `collectionEditing` | UIKit owns the native bar; `hidden` hides a *tab*, not the *bar*. May be a real behaviour change |
| Status-bar style per page | single `<StatusBar>` in the pager | Each screen must own it |
| Guest locked to the Scanner | `guestLocked` prop | No native equivalent yet |

## Verifying

Deep link `spotlight://native-tabs`.

1. **The camera.** Tap SCAN, then come back. The camera must stop when you
   leave — watch for heat or battery drain. This is the failure this phase
   exists to catch.
2. **Reticle is full size** in the pushed camera (the bug the tab version had).
3. **Back out of the camera** with both the button and a left-edge drag.
4. **Minimize-on-scroll** in Collection; the bar collapses bottom-left.
5. Wishlist as a tab; PDP push from a Collection card.

## The native-module-probe trap

`requireOptionalNativeModule` returns `null` identically for *"not in this
binary"* and *"that name does not exist"*. Both look like a stale app and neither
is fixable by rebuilding. It cost two silent failures in one session:
`expo-image-picker` registers **`ExponentImagePicker`**, and `expo-symbols`
registers **`SymbolModule`** (`ExpoSymbols` is the CocoaPod). A guard test that
mocks the probe and asserts the render does not catch it. Both now have tests
that read the name out of the installed package; any new probe should too.
