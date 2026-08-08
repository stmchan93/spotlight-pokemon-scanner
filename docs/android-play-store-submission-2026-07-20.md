# Android Play Store Submission Runbook (2026-07-20)

Getting Ekalight (`com.ekalight.app`) onto Google Play. Org account is **verified**
(D-U-N-S → skips the 12-tester/14-day closed-test requirement), so we can go
straight toward production.

## Status / who-does-what
- [x] Play Console **Organization** account created + identity verified
- [x] `eas.json` Android submit config wired (`submit.production.android`, track `internal`)
- [ ] **New logo** → update iOS + Android icons → build (deferred by choice)
- [ ] Store listing (copy below — paste + tweak)
- [ ] Graphics: 512×512 icon + 1024×500 feature graphic (generate from new logo)
- [ ] ≥2 phone screenshots (from a build)
- [ ] Data Safety form (answers below — rewritten 2026-08-08)
- [ ] Content rating (IARC) — guidance below
- [ ] **App access**: reviewer demo login (critical — app is auth-gated)
- [x] Privacy policy URL — https://stmchan93.github.io/ekalight-legal/
- [x] Account deletion URL — https://stmchan93.github.io/ekalight-legal/delete-account/ (Play requires it)
- [ ] Google Play **service-account JSON** for `eas submit` (steps below)
- [ ] Build AAB → upload → submit for review

The build/graphics steps wait on the new logo. Everything else can be done now.

---

## 1. Store listing (paste-ready — adjust to taste)

**App name** (≤30): `Ekalight: Card Scanner`

**Short description** (≤80):
> Scan, price, and track your Pokémon card collection in seconds.

**Full description** (≤4000):
> Ekalight turns your phone into an instant Pokémon card scanner and portfolio tracker.
>
> Point your camera at a card — raw or graded — and Ekalight identifies it and shows
> its current market value in seconds. Build your collection, watch its value move over
> time, and never lose track of what you own or what you're hunting for.
>
> **Scan anything**
> • Raw cards and graded slabs (PSA) recognized instantly by the camera
> • Accurate, up-to-date pricing pulled from live market data
> • English and Japanese cards supported
>
> **Track your collection**
> • Add cards to your portfolio with one tap and see your total value
> • Performance view: gains/losses over the month and all-time
> • Price-history trends for every card
> • Wishlist the cards you're chasing
>
> **Know the market**
> • Tap through to live marketplace listings and sold comps
> • Per-condition and per-grade pricing so you value cards correctly
>
> Whether you're a weekend collector or working card shows, Ekalight keeps your
> collection organized and its value at your fingertips.

**Category:** Shopping (or Lifestyle) · **Tags:** collectibles, trading cards
**Contact:** your support email · **Website:** ekalight site

---

## 2. Data Safety form (how to answer)

> Rewritten 2026-08-08. The original draft predated avatars, cover photos,
> posts/comments/DMs and Who's That Pokemon — it under-declared, which is a
> rejection risk. Answer from THIS table.

"Collected" = leaves the device. Data handled by Supabase / Google Cloud /
PostHog as processors is **collected** but generally **not** "shared" — they act
on our instructions, not for their own purposes.

- **Does the app collect or share user data?** Yes
- **Is data encrypted in transit?** Yes (HTTPS)
- **Can users request data deletion?** Yes — BOTH:
  - in-app: Menu -> Account Settings -> Delete account (`account-screen.tsx`,
    `POST /api/v1/account/delete`, which erases the stored OBJECTS as well as
    the rows)
  - web: https://stmchan93.github.io/ekalight-legal/delete-account/
    (paste this into the Data deletion URL field — Play requires it for any app
    that allows account creation)

| Data type | Collected | Purpose | Shared | Optional? |
|---|---|---|---|---|
| Email address | Yes | Account management, sign-in (Supabase) | No | Required |
| Name / display name | Yes | Account management, public profile | No | Required |
| Photos — card scans | Yes | App functionality (card ID + pricing); also model improvement | No | Required |
| Photos — profile avatar | Yes | App functionality (public profile) | No | Optional |
| Photos — profile cover | Yes | App functionality (public profile) | No | Optional |
| Photos — post images | Yes | App functionality (social feed) | No | Optional |
| Messages — DMs | Yes | App functionality (direct messages) | No | Optional |
| Other UGC — posts, comments | Yes | App functionality (social feed) | No | Optional |
| App interactions | Yes | Analytics (PostHog) | No | Required |
| Device or other IDs | Yes | Analytics (PostHog) | No | Required |
| Crash logs / diagnostics | Yes | Crash reporting, app stability | No | Required |
| Purchase history | Yes | App functionality (portfolio transactions the user logs) | No | Optional |

**Precise location: No.** The app never requests GPS. PostHog derives coarse
geo from IP server-side; declare no location collection.

**Selfies (Who's That Pokemon) — declare only if the feature ships.** Tick
Photos, and tick **"Data is processed ephemerally"**, which is literally true
and verifiable in the code: `server.py` (`identify_pokemon_selfie`) and
`anthropic_adapter.py` both carry a HARD PRIVACY RULE — the selfie exists in
memory for the lifetime of the request, is never written to any store or DB,
and is never logged. The person-cutout runs on our own VM.

**Security practices to tick:**
- Data is encrypted in transit — yes
- Users can request data deletion — yes (both routes above)
- Committed to Play Families Policy — N/A (not directed at children; see s4)
- Independent security review — no

**Keep this consistent with Apple.** The App Privacy answers in App Store
Connect must describe the same collection, or the two listings contradict each
other and either may be flagged.

## 3. Content rating (IARC questionnaire)
- Category: Utility / Reference / Shopping (not a game).
- Violence / sexual content / profanity / drugs / gambling: **No** to all.
  (Marketplace deep links = e-commerce, not gambling.)
- Expected result: **Everyone / PEGI 3**.

## 4. Target audience & content
- Target age: **18+** (or 13+). The app is a pricing/portfolio tool aimed at collectors,
  not children — this avoids the "Designed for Families" program and its extra rules.
- "Is your app directed at children?" → **No**.

## 5. App access (do NOT skip)
The app requires login, so reviewers are blocked without credentials → auto-reject.
In Play Console → App content → **App access**, add a working demo account:
- Email + password of a seeded test user with a few cards in its collection.

---

## 6. `eas submit` for Android (once app exists in Console)
`eas.json` now has `submit.production.android` (track `internal`, status `draft`).
You need a Google Play **service account** with API access:

1. Play Console → Setup → **API access** → link/create a Google Cloud project.
2. Create a **service account**, grant it access to this app in Play Console
   (Users & permissions → invite the service-account email, "Release" perms).
3. Download its **JSON key** → save to `apps/spotlight-rn/credentials/play-service-account.json`
   (this path is git-ignored).
4. Then:
   ```bash
   eas build -p android --profile production   # after the new logo is committed
   eas submit -p android --profile production  # uploads the AAB to the internal track
   ```
5. In Console, verify the internal build installs/works, then **promote internal → Production**
   and submit for review (~a few days to a week for a first app).

---

## Release-order summary
new logo → update both icons → commit (logo + any fixes) → build iOS + Android →
Android: `eas submit` to internal → verify → promote to Production → review → live.
iOS is a normal App Store update in parallel.
