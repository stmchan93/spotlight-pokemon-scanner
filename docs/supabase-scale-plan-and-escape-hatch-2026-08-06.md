# Supabase — scale plan, cost model, and escape hatch

Date: 2026-08-06
Status: DECISION. Supersedes `docs/supabase-exit-options-and-cost-2026-07-24.md`.
Related: [[project_social_layer]], [[project_portfolio_profile_phases]],
`docs/portfolio-social-phase-3-activity-posts-comments-2026-07-24.md`,
`docs/social-layer-database-design-2026-07-20.md`.

---

## The decision

**Stay on Supabase and use it properly. Target 100k MAU. Keep a cheap escape hatch, not an
abstraction layer.**

Reasoning, in short:

- At 100k MAU the Supabase bill is **~$255–400/mo**. Every alternative costs the same or more and
  adds ops. There is no version of this product where the database bill decides the outcome.
- **Supabase auth is the cheapest managed auth that exists** — $0.00325/MAU, vs Google Identity
  Platform $0.0046, Clerk $0.02, Auth0 $0.07. "Leave Supabase to save money on auth" is backwards.
  The only cheaper option is self-hosting GoTrue, which is the same software we already run.
- The classic Supabase horror story is an **egress** bill from serving user images out of Supabase
  Storage. **We already defused that** — `avatar_store.py` and `post_media_store.py` put bytes in
  GCS, and there are zero `supabase.storage` calls left in the RN app.
- What actually breaks first at 100k MAU is **the scanner**, not the database. See the table below.

Do not revisit this without one of the triggers at the bottom firing.

---

## What "MAU" means (and the one thing worth optimizing)

Supabase bills a MAU as *"distinct users who log in or refresh their token during the billing
cycle."* Not downloads, not registered accounts — **people who opened the app that month**.

Because `apps/spotlight-rn/src/lib/supabase.ts` sets `autoRefreshToken: true` and calls
`startAutoRefresh()` on AppState `active`, **every app foreground by a signed-in user counts**.

A real returning user counts **once** per cycle no matter how often they open the app. So there is
nothing to optimize about genuine usage. The only waste is:

1. **Duplicate identities** — a user whose stored session is lost comes back as a *new* user and a
   *new* MAU.
2. **Guests who never engage** — anonymous users are billable; a fresh install that only browses
   should not cost anything.

Both are fixable, and both are also analytics-integrity problems: the same duplication inflates our
PostHog MAU numbers.

**Rules that follow:**

- Never mint an anonymous identity on app launch. Defer `signInAnonymously()` until the first action
  that genuinely needs server identity (first scan save / sync).
- The auth session store must be **persistent**, never in-memory. A lost session is a new billable
  user on every cold start.
- **Never convert a guest with `signUp()`** — that creates a second user with a new uuid, orphaning
  their data (`owner_user_id` in the backend's SQLite *is* the Supabase auth uuid) and double-billing.
  Use `updateUser({ email })` / `linkIdentity({ provider })`, which upgrade the user in place.
- Enable CAPTCHA/Turnstile plus the IP rate limit on anonymous sign-in before guest mode ships —
  otherwise it's an endpoint that lets anyone mint billable users.
- Note: deleting stale anonymous users is hygiene, but does **not** retroactively reduce a past
  month's MAU. Only preventing duplicate identities does.

---

## Scale model

Measured baseline (PostHog, 60 days to 2026-08-06): 6,865 scan requests from 43 distinct scanners,
against 63 MAU in the peak month (July) → **~54 scans per MAU per month**.

| | Today (63 MAU) | 100k MAU | 1M MAU |
|---|---|---|---|
| Scans / month | ~3.4k | ~5.4M | ~54M |
| Scans / sec (avg → peak) | ~0 | 2 → ~20 | 21 → ~200 |
| Inference CPU @ 1.2 vCPU-s/scan | 1 VM | **~24 vCPU peak** | **~240 vCPU peak** |
| New scan artifacts / month | ~1 GB | ~2 TB | ~20 TB |
| **Supabase bill** | $0 | **~$255–400** | ~$4,740 |
| **Scanner fleet bill** | ~$150 | **~$600–1,000** | ~$3,000–5,000 |

The 100k-MAU Supabase line: $25 base (100k is exactly the included tier) + ~$110–210 compute add-on
(Large/XL) + ~$70 egress (JSON only; images are on GCS) + ~$50 realtime if DMs ship + a few dollars
of disk.

**Calibration:** Collectr, the category leader, has ~2.8M lifetime Android downloads and claims
"2M+ users" — registered accounts, not MAU; its real MAU is likely low hundreds of thousands. 100k
MAU would make us a serious player. 1M would make us several times larger than today's leader.
Plan for 10k–100k.

**The important row is the last one.** We have measured 1.2 vCPU-s per scan and ~10–12 safe
concurrent scanners on a `standard-4`. At 100k MAU the single-VM SigLIP2 scanner is already past
its limit, and the 27.5M-row price history has to be replicated across a fleet. That is the hard
engineering and the bigger bill. Optimizing the database line while the scanner needs
re-architecting is the wrong order of work.

### Options at 100k MAU

| Option | Cost | Effort | Verdict |
|---|---|---|---|
| **Stay fully on Supabase** | ~$255–400/mo | $0 | ✅ **chosen** |
| Cloud SQL + self-hosted GoTrue + PostgREST | ~$350/mo + ops | 2–3 wks | saves nothing, adds on-call |
| Managed auth vendor (GIP) + Cloud SQL + own API | ~$480/mo | 4–8 wks | more expensive, worse lock-in |
| Fold everything into the Python backend | ~$350/mo + ops | 2–3 mo | only past ~300k MAU |

On-Supabase scaling work that *will* be needed and is not a migration: the feed query (keyset
pagination → materialized feed), `messages`/`notifications` growth (partition by time), and realtime
connection count.

---

## Lock-in is per-product

| Product | Lock-in | Status |
|---|---|---|
| Postgres | none — `pg_dump` | using |
| PostgREST | low — open source, self-hostable | using |
| Auth / GoTrue | medium — open source, **and the bcrypt hashes are rows in our own `auth.users`**, unlike Clerk/Auth0 | using |
| Realtime | high | planned for DMs — **accepted** |
| Storage | high (source of the egress horror stories) | already on GCS |
| Edge Functions | high | never used |

We are on the portable subset. Realtime for DMs and client-direct RLS for social are **deliberately
accepted** costs — if we ever migrate, those are the two things we rebuild. That trade buys
velocity now.

## The escape-hatch rules

These keep a future migration at ~2–3 weeks instead of ~3 months. They cost roughly three evenings
plus light ongoing discipline.

1. **Never foreign-key to `auth.users`.** ~18 FKs cascade into GoTrue's schema today. New tables FK
   to `public.users` (a trigger-maintained mirror of `auth.users.id`). Existing FKs can stay.
2. **Never read the `auth` schema from app code.**
3. **Keep one client seam.** `createClient` is called in exactly one file
   (`apps/spotlight-rn/src/lib/supabase.ts`); only 4 non-test files import `@supabase/supabase-js`;
   only 8 relations are queried client-direct. Keep new data access inside `social-service.ts` /
   `profile-service.ts`.
4. **Keep JWT verification env-driven.** `backend/request_auth.py` (148 lines) is the only thing in
   the backend that knows what an issuer is. Keep it that way.
5. **Our own backend must never delegate authorization to RLS.** Server-side checks derive from the
   verified JWT identity; RLS stays enabled underneath as defense-in-depth.
6. **Migrations stay as plain SQL in the repo**, standard Postgres only.
7. **Prove the exit once**: `pg_dump` → local Postgres → two-user RLS smoke test.

## If the hatch is ever used

Full step-by-step plan, decision log, invariants, failure modes, and rollback:
**`docs/supabase-migration-runbook-if-ever-needed-2026-08-06.md`**. Summary:

1. **Cloud SQL** — `pg_dump`/`pg_restore` carries the `auth` schema, the users, their **uuids**, and
   their bcrypt password hashes. ~1 day.
2. **Self-host GoTrue** against it — same JWT shape, so `auth.uid()`, all ~40 RLS policies, and
   `request_auth.py` keep working unchanged, and every user uuid is preserved. ~1 week.
   *This is the crux. Do not hand-roll auth in the stdlib `http.server`.*
3. **Self-host PostgREST** — client untouched, one URL changes. ~2 days.
4. **Rebuild realtime** — Postgres `LISTEN/NOTIFY` behind a WebSocket, or a portable vendor.

Total ~2–3 weeks **if** the escape-hatch rules above were honored; ~3 months if they weren't.

**Preserving every user's uuid is the hard constraint.** `owner_user_id` across ~12 SQLite tables
*is* the Supabase auth uuid. Break it and every scan, collection, transaction, and profile is
orphaned.

## Triggers to revisit

- Supabase bill > ~$1,500/mo (roughly 300k+ MAU), **or**
- a compliance or acquisition need for a single GCP IAM/VPC/bill, **or**
- reliability that materially hurts us.

Not before.

---

## Cost sources (verify before acting on exact numbers)

- [Supabase pricing](https://supabase.com/pricing) ·
  [MAU definition](https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users) ·
  [Anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Google Identity Platform pricing](https://cloud.google.com/identity-platform/pricing) ·
  [Cloud SQL pricing](https://www.bytebase.com/dbcost/cloudsql-pricing/)
- [Collectr app stats](https://www.similarweb.com/app/google/com.collectrinc.collectr/)
