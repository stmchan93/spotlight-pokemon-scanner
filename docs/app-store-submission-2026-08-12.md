# iOS App Store Submission Runbook (2026-08-12)

Getting Ekalight (`com.ekalight.app`) onto the App Store. Companion to
`docs/production-promotion-checklist-2026-08-12.md` (Phase 3) and the Android counterpart
`docs/android-play-store-submission-2026-07-20.md`. Everything paste-ready lives in this file;
keep the App Store and Play listings consistent with each other and with
`docs/legal/README.md` §5.

ASC app record: **ascAppId `6778252784`** (production, `com.ekalight.app`; already in
`eas.json` → `submit.production.ios`). Staging TestFlight app is `6778252815` — do not touch.

## Status / prerequisites (from the promotion checklist, Phase 3)

Code/config items that must land in the binary BEFORE submitting — tracked in the checklist,
summarized here because review will fail without them:

- [ ] **Turnstile wired into the app** — prod Supabase CAPTCHA is ON and enforcing; sign-in
      fails without it. `eas.json` production still has `EXPO_PUBLIC_TURNSTILE_SITE_KEY:
      "TURNSTILE_SITE_KEY_TBD"` — replace with the real site key.
- [ ] Terms/Privacy links tappable in `auth-controls.tsx` + account screen
      (see `docs/legal/PUBLISHING.md` for the URLs).
- [ ] Legal pages published to `stmchan93.github.io/ekalight-legal` (stale June versions are
      live today; new content is in `docs/legal/terms-of-service.md` +
      `docs/legal/privacy-policy.md`).
- [ ] `PrivacyInfo.xcprivacy` `NSPrivacyCollectedDataTypes` filled via Expo config (currently
      declares zero collection; PostHog + session replay ship).
- [ ] Remove unused `NSMicrophoneUsageDescription` from `app.json` (or expect a reviewer
      question — a fallback answer is in the review notes below).
- [ ] Bump `runtimeVersion` (currently `0.1.2`) so prod OTAs can't target staging-era
      binaries; fix `package.json` 0.1.0 vs `app.json` 0.1.3 version drift.
- [ ] Prod backend + data promotion complete (checklist Phase 2) — the prod build points at
      `https://looty.34.59.188.129.sslip.io` and prod Supabase `lvnjshymwvagwadqeofm`; App
      Review exercises the live prod stack.
- [ ] **Demo review account created + whitelisted on prod** (section below — user step).

---

## 1. App Store metadata (paste-ready)

**App name** (≤30): `Ekalight: Card Scanner`

**Subtitle** (≤30): `Scan, price & track your cards`

**Promotional text** (≤170, editable without review):
> Point your camera at any Pokémon card — raw or slabbed — and see what it's worth in
> seconds. Track your collection's value and wishlist the cards you're chasing.

**Description** (≤4000):
> Ekalight turns your phone into an instant Pokémon card scanner and portfolio tracker.
>
> Point your camera at a card — raw or graded — and Ekalight identifies it and shows its
> current market value in seconds. Build your collection, watch its value move over time, and
> never lose track of what you own or what you're hunting for.
>
> SCAN ANYTHING
> • Raw cards and graded slabs (PSA) recognized instantly by the camera
> • Accurate, up-to-date pricing pulled from live market data
> • English and Japanese cards supported
>
> TRACK YOUR COLLECTION
> • Add cards to your portfolio with one tap and see your total value
> • Performance view: gains/losses over the month and all-time
> • Price-history trends for every card
> • Wishlist the cards you're chasing
>
> KNOW THE MARKET
> • Tap through to live marketplace listings and sold comps
> • Per-condition and per-grade pricing so you value cards correctly
>
> SHARE THE HOBBY
> • Post your pulls and pickups to the community feed
> • Follow other collectors, comment, and send direct messages
> • Public profile that shows off your best cards
>
> Whether you're a weekend collector or working card shows, Ekalight keeps your collection
> organized and its value at your fingertips.
>
> Ekalight is not affiliated with, endorsed by, or sponsored by The Pokémon Company,
> Nintendo, PSA, eBay, or TCGplayer. Card prices are informational estimates, not offers or
> financial advice.

**Keywords** (≤100 chars, comma-separated, no spaces after commas):
`pokemon,card scanner,tcg,card prices,collection,psa,graded,slab,portfolio,trading cards,japanese`
(97 chars. Note: "pokemon" as a keyword is common practice in this category but is a
third-party mark — drop it if review objects.)

**Support URL:** `https://stmchan93.github.io/ekalight-legal/` (contact email
team@ekalight.com is on the page)
**Marketing URL** (optional): leave blank, or reuse the support URL until a marketing site
exists
**Privacy Policy URL:** `https://stmchan93.github.io/ekalight-legal/`
(verified 2026-08-12: the site ROOT is the privacy policy page; `/privacy/` 404s. Terms live
at `https://stmchan93.github.io/ekalight-legal/terms/`. See `docs/legal/PUBLISHING.md`.)

**Category:** Primary **Shopping**, Secondary **Utilities** (Play chose Shopping too — keep
them aligned)
**Price:** Free. No in-app purchases (RevenueCat removed 2026-08-12 — do NOT declare IAP).
**Copyright:** `© 2026 Stephen Chan (Ekalight)`
**EULA:** custom — paste `docs/legal/terms-of-service.md` content into App Store Connect →
App Information → License Agreement (or accept Apple's standard EULA and let the hosted Terms
govern in-app; custom is preferred since it carries the UGC/objectionable-content clause).

## 2. App Privacy questionnaire

Answer from the audited table in `docs/legal/README.md` §5 — it is the source of truth and is
already consistent with the Play Data Safety table. Headlines: email, name, user ID, photos,
UGC, **financial info (cost basis/sale prices)**, usage/crash/performance data — all
collected, all linked to identity, **none used for tracking**. No location, no device/ad ID,
no IDFA/ATT. The two easy-to-miss answers: financial info IS collected, and the display name
IS sent to PostHog.

## 3. Age rating questionnaire — answer sheet (target: 13+)

Honest answers from the app's actual features. Apple computes the rating; with UGC + user
communication these answers land at **13+**. (Play's runbook picked 18+ target audience —
revisit Play to align at 13+ per checklist Phase 4.)

Content descriptors — answer **None** to all of:
- Cartoon or fantasy violence: **None** (card artwork is store-provided catalog imagery)
- Realistic violence: **None**
- Prolonged graphic/sadistic violence: **None**
- Profanity or crude humor: **None**
- Mature/suggestive themes: **None**
- Horror/fear themes: **None**
- Medical/treatment information: **None**
- Alcohol, tobacco, or drug use or references: **None**
- Sexual content or nudity: **None**
- Graphic sexual content and nudity: **None**

Gambling and contests:
- Simulated gambling: **No** (pricing/marketplace deep links are e-commerce, not gambling)
- Real gambling with cash prizes: **No**
- Contests: **No**

Capabilities (the answers that set the floor):
- **Unrestricted web access: NO** — no in-app browser; marketplace links open externally in
  Safari.
- **User-generated content: YES** — posts, images, comments, profiles. Declare the required
  Guideline 1.2 safeguards, all of which exist: content filtering (blocked-terms prefilter +
  AI moderation pass that classifies new content within minutes and holds post images hidden
  until approved), a report mechanism on every post/comment/message/profile, user blocking
  and muting, a published acceptable-use policy in the Terms, and a developer contact
  (team@ekalight.com). Commitment: reported objectionable content is acted on **within 24
  hours** (the automated moderation worker runs every 2 minutes; human review of reports is
  the 24-hour bound).
- **User communication / messaging: YES** — direct messages between registered users
  (wordlist-filtered, reportable, block respects DMs).
- Location sharing: **No**. Personal info sharing with third parties for tracking: **No**.

Expected computed rating: **13+** (driven by UGC/social features, not content).

## 4. App Review notes (draft — paste into ASC "Notes" with real credentials)

> **Demo account (required — the app is invite-gated):**
> Email: `[PLACEHOLDER — create this account]`
> Password: `[PLACEHOLDER]`
>
> Ekalight is currently in an invite-gated rollout. New accounts without an invite are placed
> on a waitlist screen. The demo account above has been pre-granted full access and is
> pre-seeded with a card collection, so every screen (Home feed, Scan, Collection/Portfolio,
> Wishlist, Profile, card detail pages, and direct messages) is reviewable immediately after
> sign-in. Regular users bypass the gate with an invite code distributed at card-show events;
> the gate exists to control rollout capacity, not to hide functionality.
>
> **Scanner:** the Scan tab uses the camera to identify physical trading cards. Any Pokémon
> trading card (raw or a PSA-graded slab) will scan. If no physical card is available, the
> demo account's seeded collection demonstrates the post-scan experience (card detail,
> pricing, price history) without scanning.
>
> **App Transport Security exception (NSAllowsArbitraryLoads):** all production traffic is
> HTTPS over TLS with publicly trusted certificates. Our API is temporarily served from an
> IP-based hostname (`https://looty.34.59.188.129.sslip.io`, Let's Encrypt certificate)
> pending migration to our custom domain `api.ekalight.com`. The ATS exception exists solely
> for this transitional hostname arrangement; the app makes no cleartext HTTP connections in
> production, and all other endpoints (Supabase, PostHog) are standard HTTPS. We will remove
> the exception when the custom-domain migration completes.
>
> **User-generated content (Guideline 1.2):** posts, comments, images, and DMs are filtered
> by a blocked-terms list at submission and classified by an automated moderation service
> that runs every 2 minutes; images attached to posts stay hidden from other users until
> approved. Every piece of content and every profile has a Report action; users can block and
> mute each other; reported content is reviewed and acted on within 24 hours. The
> objectionable-content policy is in our Terms of Service
> (https://stmchan93.github.io/ekalight-legal/terms/).
>
> **Account deletion (Guideline 5.1.1(v)):** in-app at Menu → Account Settings → Delete
> Account; also documented at https://stmchan93.github.io/ekalight-legal/delete-account/.
> Deletion removes the account, collection data, and stored images.
>
> **Purchases:** none. The app is free with no in-app purchases or subscriptions.
>
> (If the microphone permission was not removed from this build: the
> `NSMicrophoneUsageDescription` string is declared by our camera library; the app has no
> audio feature and never records audio.)

**User steps to create the demo account (do this on PROD before submitting):**
1. In a production build, sign up a fresh account (e.g. `ekalight.review@gmail.com` or an
   alias on a domain you control) with email + password. Note: Turnstile must already be
   wired or sign-up will fail against prod.
2. Whitelist that email past the gate: add it to the prod access whitelist (runtime setting
   `access_whitelist_emails` via the admin endpoint, or `SPOTLIGHT_ACCESS_ADMIN_EMAILS` /
   an invite code from `SPOTLIGHT_ACCESS_INVITE_CODES` in the prod secrets file — the
   runtime-setting whitelist is the right lane for a non-admin demo account).
3. Sign in as the demo account and seed it: add ~10-15 cards to the collection (mix of raw
   and graded), a few wishlist entries, one or two posts, and set a display name + avatar.
4. Verify on a clean device: fresh install → sign in with the demo credentials → no waitlist
   screen → all tabs populated.

## 5. Screenshot shot-list

Required device classes: **6.9"** (iPhone 17 Pro Max / 16 Pro Max, 1320×2868 portrait) and
**6.5"** (iPhone 14/15 Plus class, 1284×2778 — ASC can auto-scale from 6.9" but upload native
6.5" if available). Capture on-device (the scanner shot needs a real camera), signed into the
seeded demo account, light mode, full battery / clean status bar. No real user data in frame.
Order in the listing = the order below (scanner first — it is the hook).

1. **Scanner** — Scan tab mid-scan: an iconic, recognizable card (e.g. a Charizard) centered
   in the reticle on a clean dark mat with even diffuse lighting, result tray visible showing
   the correct match with its price. Stage: real card, staging or prod build, scan until you
   get a confident top-1, screenshot the tray moment.
2. **Collection / Portfolio** — the You tab portfolio view: total collection value with the
   trend chart prominent, a healthy grid/list of cards beneath (mix of raw + slabs, ~15+
   rows). Stage: seed the demo account generously the day before so the chart has movement.
3. **Card detail (PDP)** — a high-value card's page: card image, current price by
   condition/grade, the price-history chart, and the marketplace link buttons visible.
4. **Feed** — Home tab with 2-3 clean, hobby-authentic posts (pack pulls, showcase photos)
   from 2-3 seeded handles, with likes/comments visible. Stage: create the posts from
   secondary seeded accounts; images must be your own photos of cards.
5. **Wishlist** — Wishlist tab populated with recognizable chase cards and their prices.
6. **Profile** — the demo account's public profile: avatar, cover image, display name +
   handle, stats, and its posts. Stage: set a tasteful cover photo and avatar first.

Optional later: overlay marketing captions on these six in a template (Play needs its own
sizes from the same shots — reuse).

## 6. Submission step order (repo lanes)

1. Land all Phase 3 code/config prerequisites (top of this doc); confirm checklist Phase 2
   (prod backend + data) is complete and prod smoke passes.
2. Publish the legal pages (`docs/legal/PUBLISHING.md`) and wire the in-app links.
3. Create + whitelist + seed the demo review account on prod (section 4).
4. In App Store Connect (app `6778252784`): enter App Information (name, subtitle,
   category, copyright, EULA), pricing (Free), App Privacy (section 2), age rating
   (section 3), version metadata (description, keywords, promo text, URLs), upload
   screenshots (section 5), and paste the review notes with the real demo credentials.
5. Verify a **clean git worktree** (the EAS build bundles the working tree — including other
   sessions' uncommitted work) and that no backend deploy is running.
6. Build + submit — production is double-gated (explicit user approval in-conversation AND
   the per-invocation env confirm):
   ```bash
   SPOTLIGHT_PROD_CONFIRM=yes pnpm frontend:release:production
   ```
   This runs `tools/run_production_mobile_release_gate.sh release` → EAS iOS build + submit
   to ASC. Unlike the staging gate it does **NOT** deploy the backend (`--skip-deploy` is
   deliberate — a prod backend deploy stays its own approved step). Build-only variant (no
   submit): `SPOTLIGHT_PROD_CONFIRM=yes pnpm frontend:build:production`.
7. In ASC: attach the processed build to the version, double-check export compliance
   (`ITSAppUsesNonExemptEncryption` is already `false` in app.json), submit for review.
8. Monitor review (first submissions typically 1-3 days). Likely reviewer questions and the
   prepared answers: ATS exception (notes above), microphone permission (remove it, or notes
   above), invite gate (demo account), UGC safeguards (notes above).
9. After approval: release manually (recommended: "Manually release this version") so launch
   timing is controlled; staging/TestFlight users are unaffected (separate app + backend).

## 7. After iOS

Play submission picks up at `docs/android-play-store-submission-2026-07-20.md` — reuse the
copy above, the Data Safety table there, and align Play's target audience with the 13+ iOS
rating (its runbook currently says 18+; checklist Phase 4).
