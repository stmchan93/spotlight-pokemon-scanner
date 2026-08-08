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
│  ├─ 20260806090000_social_10_public_users_mirror.sql      # NOT applied yet
│  ├─ …                                                    # social_11 … social_17
│  ├─ 20260812090000_social_18_moderation_wordlist_word_boundary.sql   # NOT applied yet
│  └─ 20260813090000_social_19_block_enforcement_profiles_follows_dms.sql  # NOT applied yet
├─ manual/
│  └─ user_profiles_rls_REVIEW_BEFORE_APPLY.sql   # superseded by social_08 (kept for history)
└─ email_exists.sql                 # pre-existing RPC, applied by hand; social_10 promotes it into migrations
```

## Applied state

**social_00 through social_09 are APPLIED to the live project.** (Earlier revisions of
this file said nothing had been applied — that was stale; it is fixed here.) Treat every
applied migration as **immutable history**: never edit one, always add the next file in
sequence.

`social_11` through `social_19` were added after this section was last revised, so do not
read "social_10 is the only unapplied file" off it. **`supabase migration list` is the only
trustworthy answer** to what is actually applied where — run it against staging and against
production separately, since [the two are separate projects](#staging-first-always).
`social_18` and `social_19` are new in this pass and are applied nowhere.

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

## Staging first, always

Since commit `c655471` there are **two Supabase projects**, not one:

| env | project | ref |
| --- | --- | --- |
| development + staging | `looty-staging` | `mphjenaaorntwkyivqtm` |
| production | original project (holds real accounts) | `lvnjshymwvagwadqeofm` |

Every migration goes to **staging first**, gets smoke-tested there, and only then to
production. `supabase link` rebinds the CLI to whichever project you last named, so it is
easy to push to the wrong one — re-link and re-check before every push:

```bash
cd apps/spotlight-rn
supabase link --project-ref mphjenaaorntwkyivqtm   # staging
supabase migration list                            # confirm WHICH project + what's pending
supabase db push
```

Production repeats the same three commands with `lvnjshymwvagwadqeofm`, and only after the
staging smoke test passes. The repo-wide production gate in [`AGENTS.md`](../../../AGENTS.md)
applies here too: a production push needs explicit approval, never "deploy everything".

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

### Applying `social_18` (word-boundary pre-filter + the real wordlist)

**Staging first — this one changes what gets auto-deleted.** It does two things in one
transaction, in this order, and the order is the point:

1. Replaces `tg_content_prefilter()` so `blocked_terms` matches on **word boundaries**
   (`\y…\y`) instead of a bare substring. Under the old rule a hard term `ass` removed
   every post about **Grass** Energy, `fag` hid **Cofagrigus**, `coon` hid **Zigzagoon**.
   Terms are regex-escaped before interpolation, so a term containing `.` or `(` matches
   literally and a malformed one cannot raise inside a BEFORE INSERT trigger.
2. Seeds the real list — **19 `hard`, 116 `soft`** — replacing "one test term".

Nothing about the rate limit, the `hard`→`removed` / `soft`→`pending` semantics, or the
`moderation_checked_at` handling changes. No table, column, policy or trigger is created
or altered; only two function bodies and table rows.

**Run it as `postgres`** (SQL editor or `supabase db push`). `blocked_terms` has RLS with
an admin-only policy; the owner role bypasses it, `authenticated` does not.

**Before production, know the `pending` trap.** `soft` hides a row until the AI pass
clears it — but `backend/social_moderation_worker.py` is not on a cron, and even when it
runs it only stamps `moderation_checked_at`; it never puts a cleared row back to
`visible`. So today a soft hit is a **permanent** hide. Either fix the worker first, or
apply the migration and hold the soft tier back until it is on a cron:

```sql
delete from public.blocked_terms where severity = 'soft';   -- keep the hard tier only
```

Re-running the seed block from the migration file restores it. Anything already stuck:

```sql
update public.posts set content_status = 'visible'
 where content_status = 'pending' and moderation_checked_at is not null;
```

**Verify after applying.** The migration's footer carries the queries: the Grass/`ass`
proof, a metacharacter-escaping check, a **false-positive sweep of the whole list against
real TCG vocabulary that must return zero rows**, the per-severity counts, and end-to-end
inserts proving hard→`removed` and soft→`pending`. Run at least the sweep and the counts.

### Applying `social_19` (finish enforcing blocks)

**On the critical path for the App Store submission.** Apple's reviewers exercise block and
report on UGC apps, and blocking was only enforced on some surfaces. This closes the rest.
Apply **staging first**, run the migration footer's verification block there with two real
accounts, then production.

`social_13` had already stopped a blocked user from *sending* a DM. What was still open:

| surface | before | after |
| --- | --- | --- |
| `messages` UPDATE | `sender_id = auth.uid()` only — a blocked user could **edit an existing message**, pushed live to the victim via Realtime (`social_12`) | participation **and** block gated; a blocked thread is frozen for both sides |
| `public_profiles` | filtered `status` / `is_shadowbanned` only | blocked users have no public profile, **either direction** |
| `follows` | block never touched the edges; `select using (true)` | block **deletes** the edges both ways (counters follow); SELECT filters third-party edges |
| `comments` / `comment_likes` INSERT | no block check (`post_likes` had one since `social_01`) | blocked users can't comment on, reply under, or like content they can't read |
| `notifications` | a blocked user could still ring your bell | writes suppressed at the trigger; pre-block rows filtered on read, **not deleted** |

Decisions worth knowing before you apply:

- **DM history stays readable.** `messages_select` is deliberately untouched. `reports` is
  polymorphic over `target_type = 'message'`, so a victim must be able to open the thread and
  report it — hiding it would destroy the evidence and let a harasser erase their own history
  by blocking first. The thread goes silent and immutable, not invisible. Both sides see the
  same thing, so nothing leaks from the difference.
- **Blocking deletes the follow edges** (both directions) rather than filtering them. Filtering
  alone would leave the denormalized `user_profiles.follower_count` reading one higher than the
  list underneath it, permanently — the same silent-drift class `social_07`/`social_09` exist to
  prevent. The delete fires `tg_follows_counts`, so count and list agree by construction.
  **Unblocking does not restore the follow**, by design.
- **New RPC `public.blocked_profiles()`** is the *only* way to read a blocked user's name. It
  takes no argument and is pinned to `auth.uid()` internally, so it is an unblock list, not a
  lookup tool. Hiding the profile also hides the name, and a user who can block must be able to
  unblock.
- **Nothing is deleted except follow edges.** Notifications, messages, likes and reports all
  survive a block.

One data-changing statement: a backfill that deletes follow edges for pairs that are *already*
blocked. See the blast radius before you apply — expected `0` today:

```sql
select count(*) from public.follows f
  join public.blocks b
    on (f.follower_id = b.blocker_id and f.followee_id = b.blocked_id)
    or (f.follower_id = b.blocked_id and f.followee_id = b.blocker_id);
```

**Run it as `postgres`** (SQL editor or `supabase db push`) — replacing the `public_profiles`
view requires the owner role.

**Verify after applying.** The migration footer carries a full impersonation script (`set local
role authenticated; set local request.jwt.claims = '{"sub":"<uid>",…}'`) proving that a blocked
user cannot message, edit, be seen in a follower list, or read the blocker's profile — plus a
**control section proving an unblocked pair is completely unaffected**. Run at least §3 (profile),
§4 (follows), §5 (DM edit) and §7 (the control).

Client follow-ups this migration enables but does not perform (they live in `src/`, not here):

1. A **Blocked accounts** screen backed by `blocked_profiles()`, with unblock. Expected by App
   Review, and now the only place a blocked user's name is available.
2. `hydrateDmUsers` (`dm-service.ts`) should fall back to `blocked_profiles()` so a frozen thread
   you are meant to report keeps its title.
3. The block/report comment block in `social-service.ts` (~line 1061) is stale — `social_13`
   already closed the DM send path, and this file closes the rest.

Deliberately **not** closed, and written out at length in the migration header: the
`tg_content_prefilter` trigger on `messages` is `BEFORE INSERT` only (so an edit skips the
wordlist — a moderation fix that belongs with `social_18`), group conversations over-block,
`dm_key` squatting, and `avatars` staying a public bucket.

### Adding or removing blocked terms later (no migration needed)

`blocked_terms` is admin-only (RLS `public.is_admin()`), so this is a SQL-editor / admin
task, not a schema change:

```sql
insert into public.blocked_terms (term, severity) values ('newterm', 'soft')
  on conflict (term) do update set severity = excluded.severity;
update public.blocked_terms set severity = 'soft' where term = 'toonoisy';
delete from public.blocked_terms where term = 'oops';
```

Four rules, all learned the hard way and written out at length in the migration header:

- **Always pass `severity` explicitly.** The column defaults to `hard`, and `hard` deletes
  with no human in the loop and no signal to the author.
- **`hard` is for unambiguous hate speech only.** If you can write one realistic sentence a
  collector would post that contains the word innocently, it belongs in `soft`.
- **One row per inflection.** Matching is whole-word: `fuck` does not cover `fucking`, and
  `nigger` does not cover `sandnigger`.
- **Run the false-positive sweep with your candidate added** before you commit to it. That
  is how `jap` (Japanese cards), `ho` (Ho-Oh), `trap` (Trap Cards), `sex` (Pokémon gender),
  `1488` (a card number and a price) and `kkk` (Brazilian laughter) were kept out.

## After applying

1. **Seed the wordlist.** Done by `social_18` — see above. Before it is applied,
   `blocked_terms` holds only the test term `zzblockedtest` (`hard`).
2. **Deploy the moderation worker** (the AI pass) — `backend/social_moderation_worker.py`.
   It is NOT wired to anything yet. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENAI_API_KEY`, then run `--once` to verify, later install as a 1–2 min cron.
   It also needs a one-line fix before the `soft` tier is usable in production: on a row
   the classifier does **not** flag, `_moderate_text_table()` writes only
   `moderation_checked_at`, so a `pending` row it cleared stays hidden forever. It must
   also set `content_status = 'visible'` when the current status is `pending`.
3. **Grant yourself admin** for the review queue: set `user_profiles.admin_enabled = true`
   for your `user_id`.

## Quick smoke test (after applying, as two real signed-in users A and B)

- A inserts a post → visible; B sees it. A's post body containing `zzblockedtest`
  → auto-`removed` (synchronous trigger), B never sees it.
- A uploads to `post-media` + inserts a `post_media` row (`pending`) → hidden from B
  until the worker sets `approved`.
- B cannot select a `messages` row of a conversation it isn't a participant in.
- 3 distinct users report one post → it flips to `pending` (auto-hidden).
- A blocks B (`social_19` applied) → B's follow of A is gone and both follower counts moved;
  B gets a not-found on A's profile and cannot find A in People search; B cannot send **or edit**
  a message in their shared thread, though both still read its history; B cannot comment on or
  like A's content. A still sees B via `select * from public.blocked_profiles()` and can unblock.
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
