# Native Google sign-in: plan (2026-11-21)

Status: AGREED (user picked option A), NOT BUILT. Ships with the next native build.

## Why
Google sign-in opens a browser to Supabase (`signInWithOAuth` + `openAuthSessionAsync`, `apps/spotlight-rn/src/features/auth/auth-service.ts:697-714`), so iOS shows "Ekalight wants to use lvjshymwvagwadeqofm.supabase.co to Sign In" and Google's page says "continue to …supabase.co". Apple doesn't, because it already uses the native sheet + `signInWithIdToken` (`auth-service.ts:755`) and `linkIdentity({ token })` for guests (`:1344`). Do the same for Google. Rejected alternative: Supabase custom domain (paid plan, still opens a browser).

## What the user sees after
Tap "Continue with Google" → Google's own account picker sheet (no browser, no prompt naming any website) → signed in.

## Steps
1. **Google Cloud (owner, ~20 min):** create OAuth client IDs — iOS for `com.ekalight.app.staging` and the prod bundle id; Android for each package + the EAS signing-key SHA-1s (staging and prod). The existing Web client ID (the one Supabase uses) stays and is the token audience.
2. **Supabase (both projects, staging first):** Google provider → add the iOS + Android client IDs to "Authorized Client IDs"; enable "Skip nonce check" only if the iOS SDK's nonce handling requires it (verify on device).
3. **App:** add `@react-native-google-signin/google-signin` + its Expo config plugin (iOS URL scheme = reversed iOS client ID, per-env via app.config.js). `signInWithGoogle`: `GoogleSignin.configure({ webClientId, iosClientId })` → `GoogleSignin.signIn()` → `supabase.auth.signInWithIdToken({ provider: 'google', token: idToken })`. Guest conversion: `supabase.auth.linkIdentity({ provider: 'google', token })`, same uuid-preserving path as Apple (never `signUp()` a guest). Sign-out also calls `GoogleSignin.signOut()`. Map cancel to the existing `AuthCanceledError` so cancels aren't logged as failures.
4. **Safe rollout:** if the native module isn't present (an OTA running on an old binary), fall back to today's browser flow, so the JS can ship before every user has the new binary.
5. **Build:** one native build per platform, bundled with the next planned build (EAS Android builds are capped ~15/month — no extra build just for this).

## Test plan (staging build)
- New user via Google on iOS and Android → account created, lands signed in.
- Existing Google user (signed up via the old browser flow) → same Supabase user, same collection (identity matched by Google `sub`).
- Guest → Continue with Google → uuid preserved, scanned tray + collection kept.
- Cancel the Google sheet → no error toast, no `auth_sign_in_failed`.
- Old binary + new OTA → browser flow still works.
- PostHog: `auth_sign_in_succeeded {provider:'google'}` / failures by error_code.

## Size
~1 day of app work + Google Cloud / Supabase setup + one native build per platform. Risk: low–medium (auth); staging first, prod only with approval.

## Config

App work is BUILT (2026-11-21); it does nothing until the ids below are set and a new native build ships.

Two build-time variables per environment (both are public OAuth client ids, not secrets):

| Variable | Value | Used for |
|---|---|---|
| `GOOGLE_IOS_CLIENT_ID` | that environment's **iOS** OAuth client id, e.g. `123-abc.apps.googleusercontent.com` (staging = client for `com.ekalight.app.staging`, prod = client for `com.ekalight.app`) | `GoogleSignin.configure({ iosClientId })`; its reversed form (`com.googleusercontent.apps.123-abc`) is registered as the iOS URL scheme by the `@react-native-google-signin/google-signin` config plugin and listed in `LSApplicationQueriesSchemes` |
| `GOOGLE_WEB_CLIENT_ID` | the existing **Web** OAuth client id that the Supabase Google provider already uses (the id-token audience) | `GoogleSignin.configure({ webClientId })` on both platforms |

Android needs no app variable: Google matches the Android OAuth client by package name + signing SHA-1 (created in Google Cloud, step 1).

`app.config.js` reads them with `trimEnvValue(env.GOOGLE_*)` and puts them in `extra.googleIosClientId` / `extra.googleWebClientId` (read in JS by `src/features/auth/google-sign-in-config.ts`). The plugin is added only when `GOOGLE_IOS_CLIENT_ID` is set, so builds without it are unchanged.

Where to set them:
- **Staging** — `apps/spotlight-rn/eas.json` → `build.staging.env` (EAS builds read it, and `tools/mobile_env_resolver.py` uses the same profile env for staging OTAs). Alternatively EAS environment variables for the `preview` environment (`eas env:create --environment preview --name GOOGLE_IOS_CLIENT_ID --visibility plaintext ...`); if both exist, `eas.json` profile env wins on builds.
- **Production** — `apps/spotlight-rn/eas.json` → `build.production.env` (builds) AND the local gitignored `apps/spotlight-rn/.env.production` (production OTAs run `app.config.js` from it). Or EAS env vars in the `production` environment.
- **Local dev client** — `apps/spotlight-rn/.env.development` (gitignored) if you want native Google in a dev build (needs an iOS client for `com.ekalight.app.dev`).
- Placeholders are documented in `.env.staging.example` / `.env.production.example`.

Rollout notes:
- Set the ids in the SAME change as the native build. The JS falls back to the browser flow when the binary lacks the native module, the ids are missing, or (iOS) `canOpenURL('<reversed iOS id>:/')` is false — so an OTA carrying the ids to an old binary keeps the browser flow instead of crashing GoogleSignIn on a missing URL scheme.
- Adding the native module is a native change: bump the staging/prod `runtimeVersion` per the comment in `app.config.js` with the build.
- Supabase: the iOS SDK puts a nonce in the id token that the library doesn't expose, so the Google provider likely needs "Skip nonce check" on (verify on device, staging first).
- Telemetry: native failures report `auth_sign_in_failed { provider: 'google', error_code: 'google_native:<code>' }` (e.g. `google_native:10` = Android DEVELOPER_ERROR → SHA-1/package mismatch in Google Cloud). Cancels (`SIGN_IN_CANCELLED`, `IN_PROGRESS`, cancelled response) log nothing.
