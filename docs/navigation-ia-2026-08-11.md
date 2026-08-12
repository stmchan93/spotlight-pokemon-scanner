# Navigation IA — the four tabs, and the one rule

> **STATUS: CURRENT.** Supersedes `docs/native-tabs-adoption-2026-08-07.md`, whose
> "two native tabs — Collection and Wishlist, Scan is not a tab" no longer describes
> anything.

Until now this shape lived only in code and one commit message (`2a1c97b`), and
`agent-context-index.md` had no navigation entry at all. That gap is why a drawer
item could go silently dead for weeks.

## The four tabs

`src/app/(tabs)/_layout.tsx` — Apple's `NativeTabs`.

| Tab | Route | Screen |
|---|---|---|
| **Home** | `/` | `FeedScreen` — the social feed, and the landing surface |
| **Scan** | `/scan` | `ScannerScreen`. The bar is HIDDEN here (`hidden={isScanner}`) so the camera is full-bleed and the reticle keeps its size |
| **Wishlist** | `/wishlist` | `WishlistScreen` |
| **You** | `/you` | `PortfolioScreen` — your profile |

`/portfolio` still resolves: `(tabs)/portfolio.tsx` is a `<Redirect href="/you" />`
kept for old links. It has no `<Trigger>`, so it is an alias, not a tab.

## Portfolio contains Collection

These are not synonyms, and treating them as such is what produced three names for
one surface.

- **You** — the tab, and the whole surface: a profile with avatar, cover, bio,
  follower counts and share.
- **Collection** — the set of cards. One page tab inside You, and the owner of the
  balance, chart, search and filters.
- **Portfolio** — reserved for the FINANCIAL framing ("Portfolio Value", the
  Insights performance table). **Not a navigation label.**

Page tabs inside You are `Collection / Activity`. For Sale exists and is fully
built but is flag-off (`src/features/profile/for-sale-tab.ts`) — per
`docs/marketplace-business-plan-2026-07-07.txt`, selling sits behind shop/vendor
storefronts and collector P2P is deferred, so it has no backing product yet.

## THE RULE: the drawer holds only what the tab bar does not

Drawer = **Insights · Messages · Who's That Pokémon**, plus Account Settings and
Log Out. Every one is drawer-only and every one is a stack route.

It used to also list Portfolio, Wishlist and Scan — all three bottom tabs. That
duplication bought **zero reach**: the drawer opens only from Home, You and
Wishlist, and on each of those the bar is drawn with all four tabs one tap away.

And it was the bug. `goTo` (`app-drawer.tsx`) encodes one rule — push a stack route
from a tab, replace from a stack route — and a TAB destination has no correct
branch in it. So the Portfolio row hand-rolled `router.dismissTo('/you')`:

- `dismissTo` dispatches `POP_TO`
- from a tab, that diverges INSIDE the tabs navigator
- `NativeBottomTabsRouter` special-cases only `NAVIGATE` and delegates the rest to
  `TabRouter`, which has **no `POP_TO` case**
- the action returns null and is **dropped without error**

It worked from a pushed screen (`StackRouter` implements `POP_TO`) and did nothing
from any tab. It broke the moment Wishlist and Scan were promoted from pushed
screens to tabs — three of its four origins lost the stack it was written against.

Removing the duplicates deleted the bug rather than patching it, and leaves `goTo`
sound by construction instead of correct by accident.

## Why the test suite could not catch it

Both harnesses agreed the broken code worked:

- `jest.setup.ts` mocks `expo-router/unstable-native-tabs` so `<NativeTabs>` renders
  a `<Slot>` — which builds a **StackRouter**, where `POP_TO` works fine.
- `app-drawer-test` hands the component a jest-mocked router, so asserting
  "`dismissTo` was called" passes green regardless of whether any navigator could
  handle it.

`__tests__/routes/native-tabs-router-contract-test.ts` now drives the REAL
`NativeBottomTabsRouter` with no rendering and asserts `POP_TO` → null,
`NAVIGATE` → a moved index. If an expo-router upgrade lifts the constraint, that
test fails — which is the signal, not a breakage.

Teaching `renderAppRouter` to build a real `NativeBottomTabsRouter` is the
higher-value follow-up, and the reason this reached a user. Deferred: it is
jest-setup surgery with broad blast radius.

## Deferred

- **Profile asymmetry.** Own profile = Collection/Activity (Wishlist is a bottom
  tab); other people's = Collection/**Wishlist**/Activity
  (`public-profile-screen.tsx`). Deliberate for now: your own wishlist is a tool you
  edit constantly and earns a permanent tab; someone else's is content you browse
  where you already stand. The real residual is that you cannot see your own
  wishlist as a visitor sees it, so you cannot tell it is public — worth a "view as
  visitor" affordance, not a structural change.
- **Removing `BottomTabBar` from `@spotlight/design-system`** — orphaned when
  `app-bottom-tab-bar` was deleted, but it is a cross-package export with a README
  entry. Its own change.
- **Wider prose sweep** of "portfolio" in Insights / Account / delete-confirm copy.
