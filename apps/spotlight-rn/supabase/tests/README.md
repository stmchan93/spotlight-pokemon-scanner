# Social-layer database tests (pgTAP)

Automated replacement for the "two phone accounts, poke it by hand" moderation
check. Everything here runs **against a local Docker Postgres only**.

## Run it

```bash
cd apps/spotlight-rn
supabase start                 # boots local Postgres + applies every migration
pnpm test:db                   # -> supabase test db --local supabase/tests
```

From the repo root: `pnpm test:db`.

If migrations changed since the stack was started, re-apply them first:

```bash
pnpm --filter @spotlight/mobile-app db:reset   # supabase db reset --local
```

Prerequisite: a running Docker daemon (Docker Desktop, OrbStack or colima). The
Supabase CLI is present but the repo currently has no Docker runtime installed —
only the `docker` client binary — so `supabase start` fails until one is set up.

> **Status: NEVER EXECUTED.** These tests were written against the migration
> sources and have not yet been run, because no Docker daemon was available on
> the machine they were authored on. The wiring is confirmed (`pnpm test:db`
> resolves and dials `127.0.0.1:54322`); the assertions are not. Expect to fix a
> shake-out issue or two on the first real run, and delete this note once the
> suite is green.

`supabase/config.toml` was generated with `supabase init` in the same pass — the
local stack needs it and the repo had none. It only configures the local Docker
stack; the linked project ref still lives in `supabase/.temp/`.

### Never point these at a real project

The CLI in this repo is linked to **`mphjenaaorntwkyivqtm` — staging, with real
users on it**. Both `supabase test db` and `supabase db reset` accept `--linked`,
and `db reset --linked` **drops the remote database**. Every script here passes
`--local` explicitly; keep it that way and never add `--linked` or `--db-url`
pointing anywhere but `localhost:54322`.

## What is covered

| file | area |
| --- | --- |
| `010_moderation_prefilter_tiers_test.sql` | `tg_content_prefilter` tiers: `zzblockedtest` → `removed`, `zzsofttest` → `pending`, ordinary text → `visible`, on posts and comments; `moderation_checked_at` handling per tier; social_18 word-boundary and case behaviour; the BEFORE UPDATE OF body path |
| `020_counter_posts_comment_count_test.sql` | `posts.comment_count` invariants (the social_20 regression) |
| `030_counter_user_profiles_post_count_test.sql` | `user_profiles.post_count` invariants (same set, other counter) |
| `040_moderation_rate_limit_test.sql` | the `c_rate_limit = 30` per-author-per-minute cap, and that it is per author and per table |
| `050_report_threshold_test.sql` | `c_threshold = 3` distinct reporters auto-hides a post/comment; 2 does not; one reporter cannot stack |
| `060_notification_visibility_test.sql` | notification generation follows visibility (the social_21 regression) |

`060` asserts, across all four notify triggers:

- a HARD-blocked comment (`removed` at insert) notifies **nobody** — the reported
  blank-notification bug;
- a SOFT-blocked comment (`pending`) is silent while hidden, and **does** notify
  on the `pending → visible` release;
- a release round trip cannot double-ping (`uq_notifications_dedupe`);
- an ordinary comment, an ordinary reply (both recipients), an ordinary comment
  like, an ordinary post like and a follow all still notify — the controls that
  stop "notify nothing, ever" passing the file;
- a hidden reply notifies neither the post author nor the parent author;
- a like on hidden content notifies nobody;
- commenting on your own post still notifies nobody (social_11).

The counter files assert, for both counters:

- a HARD-blocked row (`removed` at insert) does **not** increment;
- a SOFT-blocked row (`pending` at insert) does **not** increment;
- `pending → visible` (the AI pass clearing a row) **does** increment;
- `visible → removed` **does** decrement;
- an author soft-delete (`deleted_at`) **still** decrements (social_17);
- a hard `DELETE` of an already-hidden row does **not** double-decrement;
- restoring (`deleted_at → null`) re-increments.

## Conventions

Each file is self-contained: it opens a transaction, `create extension if not
exists pgtap`, declares its `plan(n)`, builds its own fixtures, and `rollback`s.
Nothing is left behind and files do not depend on each other or on run order.

### Test users

`auth.users` is the FK target for `posts.author_id`, `comments.author_id` and
`reports.reporter_id`, so fixtures insert straight into it — there is no GoTrue
API in the loop and `supabase test db` runs as `postgres`, which owns the table.
Only long-standing GoTrue columns are written (`instance_id`, `id`, `aud`,
`role`, `email`, `encrypted_password`, `email_confirmed_at`, the two metadata
blobs, `created_at`, `updated_at`) so the helper survives an auth-schema bump;
everything else defaults.

Two triggers fire off that insert and both are wanted here:

- social_10 mirrors the id into `public.users`;
- social_14 (`tg_auth_user_seed_profile`) seeds `public.user_profiles`, which is
  where `post_count` lives.

The helper still upserts the profile row with `on conflict do nothing` as a
belt-and-braces, so a counter assertion can never silently depend on profile
seeding working.

### Assertions on expected failures

Cases that must raise (`rate_limited`, the duplicate-report unique violation)
are wrapped in a small `pg_temp` function returning `'ok'` or
`'SQLSTATE: message'`, and asserted with `is()` rather than `throws_ok()`. The
exception handler is an implicit savepoint so the transaction stays usable, the
expected string shows up in the TAP diff on failure, and there is no ambiguity
about which `throws_ok` overload the errcode argument selects.

### Time

Each file is one transaction, so `now()` is frozen at transaction start. The
rate-limit window (`created_at > now() - interval '1 minute'`) therefore covers
every fixture row by construction — no wall-clock flakiness.
