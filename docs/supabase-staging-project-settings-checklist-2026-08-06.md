# Staging Supabase project — dashboard settings checklist

Date: 2026-08-06
Project: **`looty-staging`** — ref `mphjenaaorntwkyivqtm`, us-east-2
Dashboard: https://supabase.com/dashboard/project/mphjenaaorntwkyivqtm

Schema came across via migrations. **None of the settings below did** — they're per-project
dashboard config. This is the complete list.

> **The short answer to "can staging just match production?"**
> Mostly yes — but **three things must differ**, and getting them wrong either breaks staging or
> quietly re-links staging to production. They're marked **MUST DIFFER** below.

Which app builds talk to which project (after the 2026-08-06 split):

| Build profile | Bundle id / package | Supabase project |
|---|---|---|
| `development` | `com.ekalight.app.dev` | **staging** |
| `staging` / `preview` | `com.ekalight.app.staging` | **staging** |
| `production` | `com.ekalight.app` | **production** |

---

## 1. Apple Sign In — **MUST DIFFER**

Auth → Sign In / Providers → Apple.

The app uses **native** Sign in with Apple (`expo-apple-authentication` →
`supabase.auth.signInWithIdToken`, `auth-service.ts:566`). For the native flow, the `aud` claim in
Apple's identity token is the **app's bundle identifier** — *not* a Services ID. So Supabase's
**Client IDs** field is the allow-list of bundle ids permitted to authenticate against that project.

**Staging Client IDs:**
```
com.ekalight.app.dev,com.ekalight.app.staging
```

**Do NOT add `com.ekalight.app`.** That's the production bundle; including it would let a production
build authenticate against staging, which defeats the split you just did.

Production should conversely be **only** `com.ekalight.app`. It very likely lists all three today
(that was correct when one project served everything). Tightening it is worth doing — but see the
sequencing caveat in §8 first, because it will break Apple sign-in on already-installed staging
builds.

Secret Key / Team ID / Key ID: **can match production.** These identify *you* as an Apple developer,
not the environment, and one Apple key signs for all your bundle ids. Reuse them.

## 2. Google Sign In — **MUST DIFFER (redirect URI)**

Auth → Sign In / Providers → Google.

Google uses the **web** OAuth flow (`signInWithOAuth`, `auth-service.ts:508`), so Google redirects to
Supabase first — and the Supabase callback URL is **project-specific**:

```
https://mphjenaaorntwkyivqtm.supabase.co/auth/v1/callback
```

In Google Cloud Console → Credentials → your **Web** OAuth client → *Authorized redirect URIs*, add
that alongside the production one. One client can hold both.

Then paste the **same** Client ID and Client Secret into staging's Supabase Google provider —
those can match production.

*Cleaner alternative:* create a second Google OAuth client just for staging, so a leaked staging
secret can't touch production. Slightly more setup; better isolation. Either is defensible — the
shared-client version is what most teams do.

No iOS/Android native Google client is needed — the app never uses native Google sign-in.

## 3. URL configuration — **can match production**

Auth → URL Configuration → *Redirect URLs*, add:

```
spotlight://login-callback
```

All three build profiles use scheme `spotlight` and redirect `spotlight://login-callback`
(`eas.json`), so this value is identical across environments. Site URL can be left at its default —
this is a mobile-only flow.

> Note: `docs/supabase-auth-phase1-setup-2026-04-19.md` still says
> `com.app.LootyCards://login-callback`. That's **stale** — it was the legacy Swift app's scheme.
> Use `spotlight://login-callback`.

## 4. Email templates — **do SMTP (§5) FIRST, or the editor is locked**

> **Supabase changed this on 2026-06-03:** new free-tier projects using Supabase's *default* email
> sender **cannot edit auth email templates at all**. Projects created before that date are
> grandfathered — which is why production (created 2026-04-19) can edit them and `looty-staging`
> (created 2026-08-06) cannot.
>
> **Configuring custom SMTP removes the restriction.** So on any project created from June 2026
> onward the order is: **enable Resend SMTP (§5) → then edit templates.** Doing §4 before §5 just
> shows you a read-only editor.
> Source: https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier

Auth → Emails → Templates.

The app verifies with a **6-digit code**, not a magic link — `verifyOtp({ email, token, type })` at
`auth-service.ts:716` (signup) and `:773` (recovery). Supabase's *default* templates send a
confirmation **link**, which this app cannot consume.

Which templates actually matter depends on `mailer_autoconfirm`, and **both projects currently have
it ON** (verified live 2026-08-06 via `GET /auth/v1/settings`):

- **Reset password → must contain `{{ .Token }}`.** This one is live:
  `resetPasswordForEmail()` → `verifyOtp({ type: 'recovery' })` (`auth-service.ts:755`, `:773`).
- **Confirm signup → currently dormant.** With `mailer_autoconfirm: true`, `signUp()` returns a
  session immediately, so `signUpWithEmail` reports `needsCode: false` (`auth-service.ts:650`), the
  verify-code screen is never shown, and no confirmation email is sent. The
  `verifyOtp({ type: 'signup' })` path at `:716` is dead code under this configuration.

Set both anyway — the signup one costs nothing and becomes load-bearing the moment email
confirmation is turned on. Just don't expect a signup email to arrive while autoconfirm is on;
that's configuration, not a broken template.

## 5. SMTP (Resend) — **can match production**

Auth → Emails → SMTP Settings. Host `smtp.resend.com`, port `587`, sender `no-reply@ekalight.com`,
same Resend credentials as production. See `docs/resend-supabase-smtp-setup.md`.

**Do not skip this on staging, and do it BEFORE §4.** Two independent reasons:
1. Supabase's built-in sender is capped at **2 emails/hour for the entire project** — you'll hit that
   on your third test signup and emails will silently stop.
2. On projects created after 2026-06-03, custom SMTP is what **unlocks email-template editing** at
   all (see §4). Without it the template editor is read-only, and this app cannot work on the default
   templates because it verifies with a `{{ .Token }}` code rather than a magic link.

## 6. Rate limits — **can match production**

Auth → Rate Limits. Match production, and specifically keep **per-address `max_frequency` at 60s** —
the app's resend cooldown is built around it (`RESEND_COOLDOWN_SECONDS = 60` in
`verify-code-screen.tsx`). A different value here desynchronizes the UI countdown from reality.

## 7. Anonymous sign-ins — **required, on**

Auth → Sign In / Providers → **Allow anonymous sign-ins: ON**.

Hard prerequisite since 2026-08-06: `EXPO_PUBLIC_SPOTLIGHT_DEFER_GUEST_SESSION` now defaults ON, and
first launch enters guest mode. Without this toggle `signInAnonymously()` throws and every new user
drops to the login screen.

While you're there, consider enabling **CAPTCHA / Turnstile** on anonymous sign-in — it's an
unauthenticated endpoint that mints billable MAU. Fine to defer on staging; do it on production
before guest mode scales.

## 8. Sequencing caveat — do this in the right order

Builds already installed on devices (dev and staging TestFlight) have the **old** config baked in and
still point at the **production** Supabase project. Two consequences:

1. **Don't tighten production's Apple Client IDs yet.** Removing `com.ekalight.app.staging` and
   `com.ekalight.app.dev` from production will break Apple sign-in on every already-installed staging
   build. Ship a new staging build first (which points at the staging project), confirm sign-in works
   there, *then* tighten production.
2. Existing staging installs will keep writing to production until they're replaced. That's the
   status quo, not a regression — but it means the split isn't fully in effect until a new staging
   build ships.

## 9. Not settings, but still needed on staging

- **Test accounts.** `tools/bootstrap_staging_simulator_auth.py` and
  `tools/reset_staging_smoke_fixture.py` create fixtures via the GoTrue password grant. Re-run them
  against the new project; re-capture any hardcoded uuids.
- **Backend deploy.** `backend/.env.staging` + secrets already point at the new project, but nothing
  has been deployed. `pnpm backend:deploy:staging` when ready.
- **`social_10`** is applied to staging only. Production is deliberately still at `social_09`.

---

## Quick reference — both projects side by side

| Setting | **Production** (`lvnjshymwvagwadqeofm`) | **Staging** (`mphjenaaorntwkyivqtm`) |
|---|---|---|
| Apple → Client IDs | `com.ekalight.app` *(+ dev/staging temporarily — see §8)* | `com.ekalight.app.dev,com.ekalight.app.staging` |
| Apple → Team ID / Key ID / Secret Key | *(unchanged)* | **same as production** |
| Google → Client ID / Secret | *(unchanged)* | **same as production** |
| Google Cloud → authorized redirect URI | `https://lvnjshymwvagwadqeofm.supabase.co/auth/v1/callback` | `https://mphjenaaorntwkyivqtm.supabase.co/auth/v1/callback` |
| Auth → Redirect URL allow-list | `spotlight://login-callback` | `spotlight://login-callback` |
| Confirm-signup template | must contain `{{ .Token }}` | **same** (copy the body across) |
| Reset-password template | must contain `{{ .Token }}` | **same** (copy the body across) |
| SMTP | Resend, `smtp.resend.com:587`, `no-reply@ekalight.com` | **same** |
| Per-address `max_frequency` | 60s | 60s |
| Allow anonymous sign-ins | ON | ON |

### ⚠️ Verify production's Apple Client IDs

Production's list **must contain `com.ekalight.app`** — that's the production bundle id, and the
native Apple flow matches the identity token's `aud` against this list. If production currently lists
only `com.ekalight.app.dev` and `com.ekalight.app.staging`, then **Apple Sign In is broken for
production users right now** and has been. Check it before anything else.

The safe production value *today*, while old dev/staging builds are still pointed at production, is
all three:

```
com.ekalight.app,com.ekalight.app.dev,com.ekalight.app.staging
```

Then narrow it to just `com.ekalight.app` once a new staging build has shipped and been verified
against the staging project (§8).
