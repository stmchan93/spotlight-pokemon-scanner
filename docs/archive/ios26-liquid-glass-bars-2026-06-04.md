# iOS 26 Liquid Glass — nav + tab bars (glass only)

> **STATUS: DEFERRED — not yet implemented.** Decided 2026-06-04. Build this when the
> user asks to "implement the iOS glass bar." No app/native code has changed yet.
>
> **Decision:** native Liquid Glass *only* (no scroll-collapse), keeping the custom
> swipe-pager untouched. The friend (designer) signed off on this scope.

## Context / why
iOS 26 introduces "Liquid Glass" chrome. Native apps built with the iOS 26 SDK auto-adopt
it for nav/tab bars, and building against that SDK is becoming an App Store requirement.
This app is **Expo/React Native with fully custom JS chrome** (`headerShown: false`
everywhere — `apps/spotlight-rn/src/app/_layout.tsx`), so it will **not** auto-adopt; we
add the glass ourselves with the official Expo API, on the **top nav bar** and **bottom
tab bar** only (nowhere else).

### Why glass-only (no collapse) — the feasibility finding
- The iOS 26 **auto-collapse-on-scroll** (tab bar shrinks to the active icon) is a
  property of Apple's native tab **controller** (`UITabBarController.tabBarMinimizeBehavior`),
  which only works if that native controller **owns navigation**.
- This app's tabbed area is a **custom swipe-pager** (`TopTabsPager`, horizontal swipe
  between Portfolio ↔ Scanner) + a custom JS tab bar. Getting the native collapse would
  mean replacing that with Apple's native tab navigator — a large rearchitecture — and
  native tab bars **don't swipe between tabs**, so the swipe gesture would be lost. Ruled
  out by the user.
- A hand-built JS collapse is possible but is custom animation we'd own — also ruled out
  ("no hacky workarounds").
- The glass **material**, however, via `expo-glass-effect`'s `GlassView`, **is** the real
  native `UIGlassEffect` and needs **no** navigation change. So glass-only is fully native
  *and* keeps the pager.

### Platform split (automatic — no branches to maintain)
- **iOS 26** → real native Liquid Glass.
- **Android + iOS < 26** → exactly today's solid bars (`GlassView` degrades to a plain
  `<View>` off iOS 26, so we render the current solid surface as the fallback).

## Key existing pieces to REUSE (don't rebuild)
- **`expo-glass-effect`** (~55.0.11, already a dependency): `GlassView`
  (`glassEffectStyle: 'regular'|'clear'|'none'`, `tintColor`, `colorScheme`, + `ViewProps`)
  and `isLiquidGlassAvailable()`. Confirmed: off iOS 26, `GlassView` renders a plain
  `<View>`, so gate on `isLiquidGlassAvailable()` and supply our own solid fallback.
- **`packages/design-system/src/components/floating-bottom-nav.tsx`** — existing
  floating-pill metrics/shadow to crib for the iOS 26 pill (Figma `863-4403`: rounded pill,
  `shadow 0 8 40 rgba(0,0,0,.12)`).
- **`packages/design-system/src/components/bottom-tab-bar.tsx`** +
  **`apps/spotlight-rn/src/components/app-bottom-tab-bar.tsx`** — the live tab bar
  (full-width solid, anchored). This is the fallback look.
- The portfolio header + its `bottomNavClearance` inset pattern in
  **`apps/spotlight-rn/src/features/portfolio/screens/portfolio-screen.tsx`**
  (~155-192, 332-348) — mirror it for a top content inset.
- **`apps/spotlight-rn/src/contexts/tab-bar-chrome-context.tsx`** — the existing
  `collapseProgress`/scroll infra. **Leave untouched** (only relevant if collapse is
  revisited later).

## Approach

### 1. Shared glass primitive — `packages/design-system/src/components/glass-surface.tsx` (new)
Thin wrapper so glass usage stays confined to chrome and the iOS-26 branch lives in one
place: `isLiquidGlassAvailable()` → render `GlassView` (`glassEffectStyle="regular"`,
`colorScheme` from theme, optional `tintColor`); else render a plain `View` with a supplied
solid `fallbackColor` (+ border/shape). Same `style`/children API for the tab bar and the
header. Export from `packages/design-system/src/index.ts`.

### 2. Bottom tab bar — glass pill on iOS 26, current bar otherwise
In `bottom-tab-bar.tsx`, wrap the bar background in `GlassSurface`.
- **iOS 26:** a centered floating **glass pill** matching Figma `863-4403` (pill radius +
  shadow cribbed from `FloatingBottomNav`), containing the existing 3 tabs unchanged.
- **Fallback (Android / iOS < 26):** the current full-width solid anchored bar, unchanged.
- Tabs, icons, labels, `testID`s, tap handlers, safe-area `bottomInset` stay as-is.
  `AppBottomTabBar` unchanged. No animation, no context consumption.

### 3. Top "Collection" header — pinned glass on iOS 26, current header otherwise
In `portfolio-screen.tsx` (the screen in Figma `800-9337`):
- **iOS 26:** lift the header row (menu + "Collection" + right slot) **out of the
  ScrollView** into an absolutely-positioned top overlay wrapped in `GlassSurface`; add a
  matching **top content inset** so content scrolls *under* the glass. Add the
  **share/export icon** in the right slot to match the Figma (wire to an existing portfolio
  share/export action if present, else stub + flag).
- **Fallback:** keep the header exactly as today (inline, scrolls with content).
- Gate the pin/glass on `isLiquidGlassAvailable()` so each platform keeps its already-correct
  behavior (no shared half-state).

### 4. Build / runtime requirement
- Real Liquid Glass only renders in a binary **compiled with the iOS 26 SDK (Xcode 26)**.
  `eas.json` pins no `ios.image` (uses EAS's latest) — **verify that image ships Xcode 26**;
  pin `build.*.ios.image` to an Xcode-26 image only if the default lags. Deployment target
  stays **15.5** (glass is runtime-gated).
- The glass look needs a **fresh native build** — it will **not** appear via OTA; current
  dev/TestFlight binaries show the solid fallback until rebuilt.
- Verify `expo-glass-effect` runs on the app's current RN architecture during the build.

### 5. Tests
- Add a jest mock for `expo-glass-effect` in `apps/spotlight-rn/jest.setup.ts`
  (`GlassView` → `View`, `isLiquidGlassAvailable` → `false`) so existing component tests
  keep rendering the solid fallback and stay green.
- Light coverage: `GlassSurface` renders the fallback `View` when glass is unavailable;
  tab bar/header still render their tabs/title under the mock.

## Critical files
- `packages/design-system/src/components/glass-surface.tsx` (new) + `packages/design-system/src/index.ts` (export)
- `packages/design-system/src/components/bottom-tab-bar.tsx`
- `apps/spotlight-rn/src/features/portfolio/screens/portfolio-screen.tsx`
- `apps/spotlight-rn/jest.setup.ts`
- `apps/spotlight-rn/eas.json` (verify/pin Xcode 26 image — only if EAS default lags)

## Verification
- `pnpm --filter @spotlight/mobile-app typecheck` + `lint` + `test` (jest) green.
- Run on an **iOS 26 simulator via a dev build compiled with Xcode 26** (`expo run:ios`):
  collection screen shows a glass pinned header (content scrolls under it) + a glass
  tab-bar pill.
- Fallback check on a non-iOS-26 sim / Android: bars/header render exactly as today.
- The glass look ships via a **new native build**, not OTA.

## Figma references
- Tab bar glass pill: node `863-4403`
- Collection screen (nav bar + tab bar in context): node `800-9337`
