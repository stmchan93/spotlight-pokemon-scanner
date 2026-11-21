# Big production release: planning notes (2026-11-21)

Decision (owner, 2026-11-21): staging fixes reach production as ONE planned release — backend deploy + new app build together — not piecemeal hotfixes. Production today runs the `hotfix/prod-memory-2026-11-15` backend branch + app 1.3.3 (runtime 1.3.3); main has weeks of staging-only work.

## What ships (all already on staging)
- Set progress search (sets list with per-set completion, set page with full-set value, rarity chips, QTY stepper) — 849b16c1
- No endless spinners (body-covering timeout, 20 s load cap, Retry, foreground refetch) — f61718a3
- Shutter taps queued instead of dropped (no cap, 2 s expiry) — 52d5d7e0, 26f85bc8
- ADD feedback + `scan_add_tapped` tracking — 52d5d7e0
- Native Google sign-in (no "…supabase.co" prompt) — 807edaeb
- Guest → existing account: one Google prompt, guest scans carry over — 46659eb8
- Scrydex sync safeguards + history-gap backfill — already on prod (hotfix branch)
- Card-back placeholder guard + re-embed tool — already on prod (hotfix branch)

## Checklist (each production step needs explicit approval + `SPOTLIGHT_PROD_CONFIRM=yes` typed per invocation)
1. Soak everything on staging; owner verifies the guest → ADD → Google flow on staging build 18 (runtime 0.1.6).
2. Reconcile branches: everything on the prod hotfix branch must be on main (it is, as of 11/21: sync safeguards, alerts, backfill, card-back guard, memory caps); deploy production from **main**.
3. Production backend deploy via the release gate.
4. Bump the production runtimeVersion in `app.config.js` (`SPOTLIGHT_RUNTIME_VERSION_BY_ENV.production`) — the release adds a native module (`@react-native-google-signin/google-signin`).
5. Production app build (iOS + Android) → TestFlight / Play internal → store review.
6. Supabase **production** project: turn ON "Google → Skip nonce checks" right before the build goes live (native Google id tokens carry a nonce the free library can't pass). Staging has it on.
7. Google OAuth clients already exist for prod iOS (`com.ekalight.app`) and Android (Play signing, previous Play key, upload key); Supabase prod lists all client ids.
8. Commit `tools/native-fingerprints.json` after each native build.
9. Post-release checks: PostHog `auth_sign_in_failed {provider:google}` error codes, `scan_add_tapped` outcomes, `scan_shutter_blocked` reasons, scan success rate.

## Upcoming deadline: iOS 27 SDK (Apple ITMS-90725)
- Apple: from **April 2027**, uploads must be built with the iOS 27 SDK (Xcode 27+). Build 18 (staging 1.3.3) used Xcode 26.2 — accepted with a warning.
- We are on **Expo SDK 55**, which EAS pairs with `macos-sequoia-15.6-xcode-26.2` (`sdk-55`). EAS's Xcode 27 images (`macos-tahoe-26.6-xcode-27.x`, `latest` = 27.1) are paired with **Expo SDK 58**.
- Real fix: **upgrade Expo SDK 55 → 58** (a few days: dependency bumps, camera/scanner + vision-camera regression testing, new native build). Plan it as its own project early 2027, staging first, before any spring show.
- Optional probe: one staging build pinning `"image": "macos-tahoe-26.6-xcode-27.2"` on SDK 55 to see if it builds — unsupported combination, only useful as a stopgap.
