# Supabase project split — what changed, what protects production, how to promote

Date: 2026-08-06
Status: DONE on staging. Production deliberately untouched.

Related: `docs/supabase-scale-plan-and-escape-hatch-2026-08-06.md` (the decision),
`docs/supabase-migration-runbook-if-ever-needed-2026-08-06.md` (the standby exit plan).

---

## The problem this fixes

Until today there was **one** Supabase project (`lvnjshymwvagwadqeofm`, "looty") serving development,
staging **and** production. `eas.json` hardcoded the same URL and publishable key in all three build
profiles, and `backend/.env.staging` was byte-identical to `backend/.env.production`. Every staging
sign-in, every smoke-test fixture, and every schema migration hit the project holding real user
accounts.

## The two projects now

| | Project | Ref | Region | Holds |
|---|---|---|---|---|
| **Production** | `looty` | `lvnjshymwvagwadqeofm` | us-east-2 | **All real users.** Untouched. |
| **Staging** | `looty-staging` | `mphjenaaorntwkyivqtm` | us-east-2 | Fresh. Full schema, no real users. |

Both sit in org `lgvsnsoitiujdnuyafig`. The Supabase Free plan allows **2 active projects per
organization**, so the split costs $0. (On Pro it would be ~$10/mo for the second project's Micro
compute — the included $10 credit only covers the first.)

The staging DB password is at `~/.spotlight-staging-db-password` (mode 600), outside the repo.

## A gap this exposed

`social_00` opens with `alter table public.user_profiles ...`, but that table only ever existed as
hand-run SQL in `docs/supabase-auth-phase1-setup-2026-04-19.md`. It was in **no migration**, so the
chain was not self-contained and `supabase db push` against a fresh project failed immediately.

Fixed by `20260419210000_auth_00_user_profiles_base.sql`, backdated ahead of `social_00`. It
deliberately omits the three permissive RLS policies from that doc — `social_08` exists precisely to
drop every pre-existing policy on `user_profiles`, so reproducing them would reintroduce the hole it
was written to close. RLS on that table is owned end-to-end by `social_08`.

**Consequence: the migration chain now replays from zero.** All 12 files applied cleanly to the new
project — the first time that has ever been proven.

Verified on staging: 17 tables · 42 public policies · 8 storage policies · 13 `SECURITY DEFINER`
functions · 1 view (`public_profiles`) · 2 triggers on `auth.users` (the `social_10` mirror) · RLS on
`public.users` · both mirror-integrity queries return 0.

---

## What protects production right now

Production is functionally identical to what it was this morning. Five independent things keep it
that way:

1. **No SQL has been run against `lvnjshymwvagwadqeofm`.** No migrations, no ledger writes, nothing.
   `social_10` is applied to **staging only**.
2. **The Supabase CLI is linked to staging** (`apps/spotlight-rn/supabase/.temp/linked-project.json`
   → `mphjenaaorntwkyivqtm`). A stray `supabase db push` hits staging, not production.
3. **`eas.json`'s `production` profile still points at `lvnjshymwvagwadqeofm`.** Only `development`
   and `staging` were re-pointed. A production build still talks to the production project.
4. **`backend/.env.production` is untouched.** Only `backend/.env.staging` and its secrets file were
   re-pointed, and nothing has been deployed.
5. **Production deploys are already gated** — `SPOTLIGHT_PROD_CONFIRM=yes` per invocation, per
   `AGENTS.md`. All app-code changes reach production only via `frontend:update:production` or
   `frontend:release:production`.

**The base migration is also a no-op on production by construction** — `create table if not exists`,
`create or replace function`, `drop trigger if exists` + `create trigger`, and no policies. Even if
it were executed there, nothing would change. That is why the ledger repair below is housekeeping,
not a safety requirement.

---

## Promotion checklist — run when you're ready, in this order

Nothing here is urgent. Do it when staging has proven itself.

### 1. Reconcile production's migration ledger (housekeeping, no SQL executed)

Production has `social_00`–`social_09` applied but doesn't know about the new base migration. Tell
the ledger it's already applied, so a future push doesn't try to run it:

```
supabase link --project-ref lvnjshymwvagwadqeofm --workdir apps/spotlight-rn
supabase migration repair --status applied 20260419210000
supabase migration list --linked          # confirm only social_10 is pending
supabase link --project-ref mphjenaaorntwkyivqtm --workdir apps/spotlight-rn   # RE-LINK TO STAGING
```

Requires the **production** DB password (Dashboard → Project Settings → Database). Always re-link to
staging afterwards so the default target is never production.

### 2. Apply `social_10` to production — only when app code needs it

`social_10` adds `public.users` plus **two triggers on `auth.users`**. The insert trigger runs
**inside every signup transaction**; if it ever raises, signups fail with GoTrue's opaque
"Database error saving new user".

Nothing reads `public.users` yet, so there is no reason to apply it to production until a feature
depends on it. When you do:

- verify on staging first that a fresh signup still succeeds and both mirror-integrity queries
  return 0;
- apply during low traffic;
- **never drop `public.users` without dropping its triggers first.**

### 3. Backend

`backend/.env.staging` now points at the staging project. Deploy staging (`pnpm backend:deploy:staging`)
and confirm JWT verification works against the new JWKS URL before considering production. Production
backend config is unchanged and needs no action.

### 4. Rotate the old production publishable key (optional)

The production publishable key was committed in `eas.json` and `.env.development.example`. Both now
point at staging, but the production key is still in git history. Publishable keys are designed to
ship in the client bundle, so this is low severity — but rotating it closes the loop. It requires an
app release, since the key is baked into the bundle.

---

## Follow-on work not yet done

- **Staging has no test accounts.** `tools/bootstrap_staging_simulator_auth.py` and
  `tools/reset_staging_smoke_fixture.py` create fixtures via the GoTrue password grant; they will
  need to run against the new project, and any hardcoded uuids re-captured.
- **Auth providers are not configured on staging.** Apple and Google OAuth, the
  `com.app.LootyCards://login-callback` redirect allow-list, and the Resend custom SMTP settings all
  live in per-project dashboard config and did **not** come across with the schema. Email/password
  and anonymous sign-in work today; social sign-in on staging will not until these are set. See
  `docs/supabase-auth-phase1-setup-2026-04-19.md` and `docs/resend-supabase-smtp-setup.md`.
- **"Allow anonymous sign-ins" must be enabled on the staging project** — this is now a hard
  prerequisite, because the deferred-mint guest flow was turned **ON by default** on 2026-08-06
  (`EXPO_PUBLIC_SPOTLIGHT_DEFER_GUEST_SESSION`). Without it, `signInAnonymously()` throws on staging
  and every first-launch user drops to the login screen. One toggle:
  https://supabase.com/dashboard/project/mphjenaaorntwkyivqtm/auth/providers
  (It is already enabled on production.)
- `tools/audit_release_config.py` should learn that staging and production have different refs, so a
  future misconfiguration is caught by the release gate rather than by a user.
