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
│  └─ 20260720090500_social_05_storage_and_seed.sql
├─ manual/
│  └─ user_profiles_rls_REVIEW_BEFORE_APPLY.sql   # touches the LIVE auth table — apply by hand
└─ email_exists.sql                 # pre-existing RPC (unrelated)
```

The migrations are **additive only** — brand-new tables + additive columns on
`user_profiles`. Applying them has **no effect on the live app** (nothing queries
these tables yet). RLS on the existing `user_profiles` table is intentionally left
out of the migrations and isolated in `manual/` because it touches auth.

## Validate FIRST, then apply (recommended)

Nothing here has been applied yet. Do NOT run this straight against production without
validating. Two safe ways:

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
supabase db push                                  # runs migrations/ in order
```
(Or paste each `migrations/*.sql` into the Supabase SQL editor in order.)

Then, **consciously**, after reviewing it against your current dashboard policies:
```bash
# review this file first — it enables RLS on the live user_profiles table
psql "$DATABASE_URL" -f supabase/manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql
```

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
