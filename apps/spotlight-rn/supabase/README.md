# Supabase — social layer backend

Migrations + policies for the social layer (posts, comments, likes, follows, DMs,
moderation). Design doc: [`docs/social-layer-database-design-2026-07-20.md`](../../../docs/social-layer-database-design-2026-07-20.md).

## What's here

```
supabase/
├─ migrations/                      # applied in filename order by `supabase db push`
│  ├─ 20260720090000_social_00_identity_helpers_graph.sql
│  ├─ 20260720090100_social_01_posts_comments_reactions.sql
│  ├─ 20260720090200_social_02_messaging.sql
│  ├─ 20260720090300_social_03_notifications.sql
│  ├─ 20260720090400_social_04_moderation.sql
│  ├─ 20260720090500_social_05_storage_and_seed.sql
│  ├─ 20260722090000_social_06_profile_fields_avatars.sql
│  ├─ 20260723090000_social_07_public_profiles_view_counter_triggers.sql
│  ├─ 20260724090000_social_08_user_profiles_rls_hardening.sql
│  ├─ 20260726090000_social_09_engagement_counter_triggers_security_definer.sql
│  └─ 20260806090000_social_10_public_users_mirror.sql      # NOT applied yet
├─ manual/
│  └─ user_profiles_rls_REVIEW_BEFORE_APPLY.sql   # superseded by social_08 (kept for history)
└─ email_exists.sql                 # pre-existing RPC, applied by hand; social_10 promotes it into migrations
```

## Applied state

**social_00 through social_09 are APPLIED to the live project.** (Earlier revisions of
this file said nothing had been applied — that was stale; it is fixed here.) Treat every
applied migration as **immutable history**: never edit one, always add the next file in
sequence.

`social_10` is the only file in this directory that has **not** been applied yet.

The migrations are **additive only** — brand-new tables + additive columns on
`user_profiles`. RLS on the pre-existing `user_profiles` table was promoted out of
`manual/` into `social_08`.

## Rule: new tables FK `public.users`, never `auth.users`

`social_10` creates `public.users (id uuid primary key, created_at timestamptz)` — an
id-only mirror of `auth.users`, kept in sync by AFTER INSERT / AFTER DELETE triggers on
`auth.users`.

- **Every new table that references a user MUST use `references public.users(id)`.**
- **Do not add new `references auth.users(id)` foreign keys.** The 18 that exist
  (social_00..social_04) stay as-is — re-pointing live constraints buys nothing while
  we're on Supabase — but the count stops growing here.
- FKs to the mirror must be `on delete cascade`, or `on delete set null` for nullable
  attribution columns (matching social_02/03/04). Anything `restrict`/`no action` would
  raise inside the delete trigger and **break account deletion**, including the
  backend's admin-API delete path.
- The mirror holds **ids only — never email, phone, or any other PII.** It exists to be
  a foreign-key target; profile data lives in `user_profiles` / `public_profiles`.
- `public.email_exists(text)` intentionally still reads `auth.users` — it needs an email
  and the mirror deliberately has none. It is the single remaining public→auth read, and
  the reasoning is written out at length in `social_10`.

Why: ~18 FKs into GoTrue's proprietary `auth` schema are the single most expensive thing
to unwind if we ever leave Supabase. The mirror reduces that to "populate `public.users`
from the new identity provider, repoint one trigger and one RPC."

## Validate FIRST, then apply (recommended)

Do NOT run an unapplied migration straight against production without validating. Two
safe ways:

**A. Local (needs Docker + the Supabase CLI):**
```bash
cd apps/spotlight-rn
supabase init            # only if there's no config.toml yet
supabase start           # local Postgres
supabase db reset        # applies every migration from scratch — proves they're clean
```

**B. A preview branch / throwaway project** (no Docker): create a scratch Supabase
project, `supabase link` to it, `supabase db push`, and smoke-test.

## Apply to your project

```bash
cd apps/spotlight-rn
supabase link --project-ref <your-project-ref>   # one-time
supabase db push                                  # runs any UNAPPLIED migrations, in order
```
(Or paste the unapplied `migrations/*.sql` into the Supabase SQL editor in order.)

### Applying `social_10` (the `public.users` mirror)

Safe to apply to the live project with existing users. It is additive and fully
transactional: one new table, two triggers on `auth.users`, a backfill, and a
semantically-identical re-creation of `email_exists`. Nothing existing is altered, and no
app code reads `public.users` yet.

Two things to know before you run it:

1. **Run it as `postgres`.** `create trigger ... on auth.users` requires ownership of that
   table. The Supabase SQL editor and `supabase db push` both qualify; a weaker role fails
   cleanly inside the transaction.
2. **The insert trigger runs inside signup.** If it ever raises, new signups fail with
   GoTrue's opaque "Database error saving new user". So: verify immediately after applying,
   and never drop `public.users` without first dropping the triggers.

Verify (both must return 0), then sign up one throwaway account and re-run:

```sql
select count(*) from auth.users u
  left join public.users m on m.id = u.id where m.id is null;   -- auth users not mirrored
select count(*) from public.users m
  left join auth.users u on u.id = m.id where u.id is null;     -- orphaned mirror rows
select public.email_exists('<a real account email>');           -- must still return true
```

Rollback is `drop trigger auth_users_mirror_insert on auth.users; drop trigger
auth_users_mirror_delete on auth.users; drop table public.users;` — safe as long as nothing
has started FK'ing the mirror yet.

## After applying

1. **Seed the wordlist.** `blocked_terms` ships with one harmless test term
   (`zzblockedtest`, severity `hard`). Add your real hard/soft terms (admin-only table).
2. **Deploy the moderation worker** (the AI pass) — `backend/social_moderation_worker.py`.
   It is NOT wired to anything yet. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENAI_API_KEY`, then run `--once` to verify, later install as a 1–2 min cron.
3. **Grant yourself admin** for the review queue: set `user_profiles.admin_enabled = true`
   for your `user_id`.

## Quick smoke test (after applying, as two real signed-in users A and B)

- A inserts a post → visible; B sees it. A's post body containing `zzblockedtest`
  → auto-`removed` (synchronous trigger), B never sees it.
- A uploads to `post-media` + inserts a `post_media` row (`pending`) → hidden from B
  until the worker sets `approved`.
- B cannot select a `messages` row of a conversation it isn't a participant in.
- 3 distinct users report one post → it flips to `pending` (auto-hidden).
- Run `social_moderation_worker.py --once` → `moderation_checked_at` fills in and
  pending media resolves.

## Rollback

Everything new is namespaced; to drop the social layer without touching auth:
```sql
drop table if exists public.notifications, public.messages, public.conversation_participants,
  public.conversations, public.comment_likes, public.post_likes, public.comments,
  public.post_media, public.posts, public.reports, public.moderation_actions,
  public.blocked_terms, public.follows, public.blocks, public.mutes cascade;
-- (the added user_profiles columns are harmless to leave; drop them explicitly if desired)
```

`public.users` is deliberately NOT in that list. Drop it only via the `social_10` rollback
above — **triggers first, table second**. Dropping the table while the triggers still exist
breaks every new signup.
