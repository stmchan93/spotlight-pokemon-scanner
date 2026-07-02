# Guest mode: first-launch scanner under a phantom account, everything else gates to login

Status: **DEFERRED — planned 2026-07-02, not implemented.** Product decisions below are confirmed with
the user; build when asked. All client-side / OTA-able; one Supabase ops prerequisite.

## Context

Today the app is all-or-nothing: signed out = login screen, nothing else. The idea: someone who
**just downloaded the app** should land straight on the **scanner** under a phantom account. They can
(a) scan cards and (b) tap a scan-tray item's text to open the card's product detail page (PDP) —
**that's it**. Every other tap (even opening/swiping the scan tray, zoom, the Raw/Graded toggle, back,
search…) opens the **Log In** page (Figma 2141:7930); Sign Up goes through 2147:8097 → 2161:5039. On
the PDP, Save/ADD, Share (header + footer), the ♥ wishlist heart, and edit/delete also gate to login.
Those three Figma screens are **exactly the light-theme `LoginScreen`/`SignUpScreen` already shipped**
(2026-07-01 auth redesign) — no new auth UI needed; they get presented over the guest experience as a
route.

Decisions confirmed with the user (2026-07-02):
- **First-launch only**: guest mode only when the device has never signed in. After a real login (or
  logout), the normal login screen shows — never the phantom account again.
- **Strict gating** on the scanner: only capture + tray-item-text→PDP are allowed; zoom and the
  Raw/Graded toggle gate too.
- **Post-login lands on Collection home** (the session switch remounts the app; no route restore).
- **Fresh start on signup** (guest tray does not carry over; guest scans still reach the backend as
  training data).
- **Guests bypass the invite/access gate**; it still applies to real accounts.

## Architecture: the phantom account = Supabase anonymous sign-in

`@supabase/supabase-js ^2.104.1` (installed) supports `auth.signInAnonymously()`: each guest device
gets a real session + JWT (`user.is_anonymous === true`, no email). Because every backend call already
injects whatever Supabase JWT exists (`requestInitWithAuth`, repository.ts), **scan/match + card-detail
endpoints work for guests with ZERO backend changes**. ⚠️ **Ops prerequisite:** enable "Allow anonymous
sign-ins" in the Supabase dashboard (Auth → Providers) before shipping; code must degrade gracefully
(fall back to the normal login screen) if the call fails.

### Auth-state changes (`src/providers/auth-provider.tsx`, `src/features/auth/auth-models.ts`)
- Expose `isGuest` on the auth context: `currentSession?.user.is_anonymous === true`.
- `updateFromSession`: for anonymous sessions skip `requiresProfileCompletion` (it would trap guests on
  the profile screen — they have no displayName source) → state `'signedIn'` with a synthetic user
  (displayName `'Guest'`).
- **First-launch trigger:** on initial session resolution, if there is no session AND the persisted
  flag `@spotlight/auth/has-signed-in` (AsyncStorage) is absent → call `signInAnonymouslyForGuest()`
  (new fn in `auth-service.ts`) → guest session. If the flag exists → `'signedOut'` (today's login
  flow). If anonymous sign-in errors (dashboard toggle off, network) → `'signedOut'` fallback.
- Set the flag whenever a **non-anonymous** session is observed (covers existing installs updating to
  this build, real logins, and signups). `signOut` keeps its behavior → `'signedOut'` → login screen.
- Guest → login/signup uses the **existing** `signInEmail`/`signUpEmail` actions; the new real session
  replaces the anonymous one via `onAuthStateChange` (verify the signUp-while-anon-session path in
  manual testing).

### Access gate (`src/features/auth/access-gate-provider.tsx`)
- Skip the backend `getAccessStatus()` check when `isGuest` → always `'allowed'` for guests.

### Login-on-demand route
- New route `src/app/(modal)/login.tsx` hosting the existing **`SignedOutFlow`** (login-rooted, with
  Sign Up + forgot-password steps — matches all three Figma nodes). Pass a new optional
  `onClose` → the login root's back button dismisses to the guest scanner (`router.back()`); today the
  flow's login root passes no `onBack`, and `LoginScreen.onBack` is already optional.
- After a successful real login, the session change flips `AuthenticatedAppProviders`' key → the app
  remounts at the tabs root → **Collection home** (decision satisfied by existing architecture — no
  extra code).

### The gating hook (new, `src/features/auth/use-guest-gate.ts`)
```ts
const { isGuest, gate } = useGuestGate();
// gate(fn): if isGuest → router.push('/login'); else fn()
```
Single, prop-drillable helper; screens that already receive callbacks can be wrapped at the call site.

### Guest landing tab
- `src/app/(tabs)/index.tsx`: `initialPage = isGuest ? 'scanner' : (requestedPage === 'scanner' ? 'scanner' : 'portfolio')`.
- `src/components/top-tabs-pager.tsx`: disable the horizontal swipe to Collection when guest (there is
  an existing swipe-disable mechanism — `onTopLevelSwipeEnabledChange` / scanner gesture flags).

## Gating inventory (strict mode)

**Scanner (`src/features/scanner/screens/scanner-screen.tsx` + tray/capture-surface):**
ALLOWED: the capture tap (`onCapture`), tapping a tray item's text → PDP (`handleOpenCard`, testID
`scanner-tray-open-card-[i]`).
GATED (→ `/login`): tray expand tap + swipe-up gesture; ADD per row (`handleRowAddToCollection`); row
menu + wishlist (`handleRowMenuSelect`/`handleRowWishlist`); change-card (`openChangeCardPicker`);
price selector; eBay row link (`handleEbayTrayTap`); swipe-delete row; ADD ALL
(`handleOpenAddAllMenu`); CLEAR ALL (`handleClearAllCaptures`); zoom buttons (`setZoomFactor`);
Scanning-for pill (`setCardType` trigger); back/exit (`handleExitScanner`); header search icon;
drawer edge-swipe (disable for guests); bottom tab bar Collection/Events (`app-bottom-tab-bar.tsx`;
Scan stays allowed).

**PDP (`src/features/cards/screens/card-detail-screen.tsx` + `card-detail-hero.tsx`):**
GATED: ♥ heart (`handleToggleFavorite`), ADD ITEM (`handleOpenAddSheet`), SAVE/CANCEL + owned edit
(`handleSaveEdit`), Share — header `detail-share` AND footer `detail-share-button` (`handleShare`),
delete (`detail-delete`).
ALLOWED (view-only, per the user's list): configurator browsing (variant/grade/condition), EN/JP
toggle, price-trend rows/provider links, scrolling/reading everything.

**Defensive redirects:** Wishlist / Insights / Account / Collection screens check `isGuest` on mount →
`router.replace('/login')` (belt-and-suspenders; their entry points are gated anyway).

## What does NOT change
- Backend: nothing (anon JWT authenticates scan endpoints; access-status skipped client-side).
- The auth screens themselves (`LoginScreen`, `SignUpScreen`, forgot/verify/set-password) — reused as-is.
- Signed-in UX: identical to today (Collection landing, full app).

## Risks / notes
- **Supabase dashboard toggle** must be flipped before release; until then guests fall back to the
  login screen (graceful).
- Anonymous users accumulate in `auth.users` (one per fresh install) — acceptable; consider periodic
  cleanup + CAPTCHA/rate limits later if abused.
- Guest scans land in scan logs under anon user ids — fine (training data; never `confirmed_card_id`).
- All JS → **OTA-able**.

## Implementation order
1. `auth-service.ts` + `auth-provider.tsx` + `auth-models.ts`: anonymous sign-in, `isGuest`, first-launch
   flag, profile-completion skip, graceful fallback.
2. `(modal)/login.tsx` route + `SignedOutFlow` `onClose` prop.
3. `use-guest-gate.ts` hook.
4. Access-gate skip for guests.
5. Tabs landing + pager swipe-lock for guests.
6. Scanner gating sweep (the inventory above).
7. PDP gating sweep.
8. Bottom tab bar + drawer edge-swipe + defensive redirects.
9. Tests.

## Verification
- Unit: auth-provider transitions (first launch → guest session; flag present → signedOut; anon
  sign-in failure → signedOut; real session sets flag; signOut → signedOut), `useGuestGate` routing,
  scanner gating (guest taps ADD/zoom/tray-expand → `/login` push; capture + open-card still fire),
  PDP gating (heart/ADD/share → `/login`), tabs initialPage for guest.
- `pnpm --filter @spotlight/mobile-app typecheck && lint && test` green.
- Manual (dev build, Supabase anon sign-ins enabled): fresh install → lands on scanner, no login;
  scan a card → tray row appears; tap row TEXT → PDP opens; on PDP tap heart/Save/Share → login page;
  back returns to guest scanner; every scanner button (zoom, toggle, tray swipe, ADD, back, search) →
  login; log in with real account → app lands on Collection; kill+reopen → still real account; log
  out → LOGIN screen (not guest); sign up as new user → verify code → Collection; existing signed-in
  install upgrading → unaffected.
