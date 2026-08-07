# Native iOS 26 tabs — adoption plan

> **STATUS: Phase 1 shipped to staging 2026-08-07 (OTA, staging only).** The live
> `(tabs)` pager is untouched. Phase 2 (making native tabs the default) is NOT
> started and needs an explicit go-ahead.

Supersedes the tab-bar half of `docs/archive/ios26-liquid-glass-bars-2026-06-04.md`.

## The decision

Adopt Apple's native tab bar, accepting the loss of the Portfolio ↔ Scanner
horizontal swipe. Decided 2026-08-07 after seeing the real material on device.
The June spec had ruled this out; two of its premises no longer hold.

## What changed since June

**`tabBarMinimizeBehavior` is now a supported prop.** June ruled out
collapse-on-scroll because it needs Apple's `UITabBarController` and getting one
meant "a large rearchitecture." `react-native-screens` 4.23.0 ships that
controller (`TabsHost`), `expo-router` wraps it as
`expo-router/unstable-native-tabs`, and both are already installed. The
`unstable-` prefix is about API churn, not the glass.

**No React Native alpha is involved.** The glass is not an RN feature. iOS 26
applies Liquid Glass to any real tab controller; RN 0.83.6 is irrelevant to it.

**It is OTA-able.** `RNScreens` ships `ios/bottom-tabs/` in the pod, so
`RNSBottomTabs` is already compiled into the current TestFlight binary. The whole
migration is JavaScript.

**Still true from June:** native tab bars do not swipe between tabs. That cost
was accepted this time; it was not eliminated.

## What the pager actually does

`top-tabs-pager.tsx` is 358 lines and only some of it is swiping. Everything
below has to land somewhere before Phase 2 can flip the default.

| Behaviour | Where it lives now | Status |
|---|---|---|
| Portfolio ↔ Scanner horizontal swipe | pan responder | **Dropped by decision** |
| `activePage` → camera mount gate | `scanner-screen.tsx:879` | Phase 1 — mapped to focus |
| `activePage` → inventory load gate | `use-portfolio-screen-model.ts:447` | Phase 1 — mapped to focus |
| `chartScrubLockRef` | `portfolio-chart-card.tsx:688` | Phase 1 — inert, no pager to block |
| Status-bar style per page | single `<StatusBar>` in pager | **Open** |
| Guest locked to Scanner | `guestLocked` prop | **Open** |
| Hide tab bar during Collection edit mode | `collectionEditing` | **Open** |
| Left-edge swipe opens the hamburger drawer | pager pan responder | **Open** |
| Scanner back → pop vs. slide | `hasVisitedPortfolioRef` | Resolved by native tabs |
| `onTopLevelSwipeEnabledChange` | scanner → pager | Deleted with the pager |

The four "Open" rows are the real remaining work. Two deserve calling out:

- **The drawer's edge swipe has no new home.** Opening the hamburger by dragging
  from the left edge is implemented inside the pager's pan responder
  (`top-tabs-pager.tsx:194-200`). Delete the pager and that gesture disappears —
  the button still works, the gesture does not. It needs its own responder or an
  explicit decision to drop it.
- **Hiding the bar during edit mode may not be portable.** The pager hid its own
  JS bar by not rendering it. A native tab bar is owned by UIKit; `hidden` on
  `NativeTabOptions` hides a *tab*, not the *bar*. This may end up as a genuine
  behaviour change rather than a port.

## Phase 1 — shipped

A parallel route at `/native-tabs` rendering the **real** Collection and Scanner
in a native tab bar. Live `(tabs)` untouched.

- `src/app/native-tabs/_layout.tsx` — `NativeTabs`, `minimizeBehavior="onScrollDown"`
- `src/app/native-tabs/index.tsx` — real `PortfolioScreen`, PDP wiring copied verbatim
- `src/app/native-tabs/scan.tsx` — real `ScannerScreen`
- `src/components/native-tabs-page-bridge.tsx` — maps navigation focus onto `TabsPageContext`

**Why a parallel route and not a flag.** Making `(tabs)` switch between a pager
and native tabs means one route tree trying to be both, and the failure we care
about most — the camera mounting when it shouldn't — is exactly what hides in
that branching. Prove the behaviour first, flip the default second.

**The bridge is the load-bearing piece.** In the pager both screens are mounted
permanently, so `activePage` is the only thing telling each screen it is live.
Native tabs also keep screens mounted, so the question survives the migration; it
just gets a better answer (real focus). The bridge maps focus onto the existing
contract so all four consumers work unchanged.

### How to verify Phase 1

Deep link to `spotlight://native-tabs`.

1. **Camera lifecycle — the one that matters.** Switch to Collection. The camera
   must stop. Switch back; it must restart. Watch battery/heat over a few
   minutes on Collection. A camera that stays live here is the failure mode this
   phase exists to catch.
2. **Collection loads** its inventory on focus, and refreshes on return.
3. **Chart scrub** long-press works (nothing should be stealing the gesture).
4. **Minimize-on-scroll** fires in both tabs.
5. **PDP push** from a Collection card, and back.

## Phase 2 — not started

Only after Phase 1 verifies. Close the four open rows, make `(tabs)` render
native tabs, delete `top-tabs-pager.tsx` + `app-bottom-tab-bar.tsx`, and decide
what happens to `GlassSurface` on the bottom bar (it stays for the FAB and the
portfolio header regardless — a native *nav* bar is a separate, larger question
and is not in scope here).

Retiring `src/app/glass-tabs-demo/` is part of Phase 2 cleanup; it is a
throwaway and shares no code with `/native-tabs`.
