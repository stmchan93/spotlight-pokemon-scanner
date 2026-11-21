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
