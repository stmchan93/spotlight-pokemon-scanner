-- Social layer — part 20: make the engagement counters aware of `content_status`,
-- and seed a benign SOFT test term.
--
-- ===========================================================================
-- 1. THE BUG
-- ===========================================================================
-- Content can be hidden along TWO independent axes:
--
--   * `deleted_at`     — the author (or an admin) deleted it.       social_17
--   * `content_status` — moderation hid it: 'pending' or 'removed'.  NOBODY
--
-- Every counter written so far watches the first axis and ignores the second.
-- `tg_comments_post_count()` (social_17) guards its INSERT branch on
-- `new.deleted_at is null` alone, and the transition trigger that repairs the
-- count on a soft delete fires `when (old.deleted_at is distinct from
-- new.deleted_at)` — a condition a moderation hide never satisfies.
--
-- Reproduced live: posting the seeded hard-tier test term `zzblockedtest` as a
-- COMMENT. `tg_content_prefilter` is BEFORE INSERT, so it sets
-- `content_status = 'removed'` and the row still inserts with `deleted_at` null.
-- The AFTER INSERT counter then bumps `posts.comment_count` to 1. A second
-- account sees "1 comment" on a thread that renders empty.
--
-- Three ways in, all of them live today:
--
--   a. INSERT of content the prefilter hides — 'removed' (hard tier) or
--      'pending' (soft tier). Counted at insert, hidden to every reader.
--   b. The async AI pass (backend/social_moderation_worker.py) setting
--      `content_status = 'removed'` on an UPDATE. `deleted_at` does not change,
--      so no counter trigger fires at all. Permanently wrong, no repair path.
--   c. `tg_reports_threshold()` auto-hiding a target at 3 distinct reporters.
--      Same UPDATE shape as (b), same silent miss.
--
-- Blast radius is both counters that feed the UI:
--   * `posts.comment_count`       — inflated thread sizes in the feed.
--   * `user_profiles.post_count`  — a public profile advertising posts that no
--                                   reader can open. A hard-blocked post still
--                                   increments its author's public count.
--
-- The client already works around the first one: `comments-sheet.tsx` calls
-- `posts.comment_count` stale and overwrites the card's number with the real
-- thread size via `onCommentCountResolved` once the sheet loads. That only
-- fires if a reader OPENS the thread — in the feed the wrong number just sits
-- there — and there is no equivalent patch for `post_count`. Fixing the source
-- lets that client workaround become redundant rather than load-bearing.
--
-- ===========================================================================
-- 2. THE FIX — one definition of "counted", used everywhere
-- ===========================================================================
-- The recurring cause is that each counter re-states the predicate inline, so a
-- new hiding mechanism only has to be forgotten in one place to drift. This
-- file states it ONCE, in `public.is_counted_content()`, and every trigger and
-- the backfill below call it. A future third axis is then a one-line change
-- here plus a backfill, not an audit of six function bodies.
--
--     counted  <=>  deleted_at is null AND content_status = 'visible'
--
-- Note this deliberately treats 'pending' as NOT counted. A soft-tier hit is
-- invisible to everyone but its author, so counting it would leak the same way
-- 'removed' does. When the AI pass releases it to 'visible' the UPDATE
-- transition trigger below increments then — the count follows visibility.
--
-- ===========================================================================
-- 3. WHAT THIS FILE DOES NOT DO
-- ===========================================================================
--   * Does not touch `like_count` on either table. Likes are only reachable
--     through content a user can already see, and a like row itself carries no
--     `content_status`. If a liked comment is later hidden, its like_count is
--     simply unread. No axis to track.
--   * Does not touch `tg_comments_redact_body()`. A moderation-removed comment
--     is not a tombstone and must not be rewritten into one — the author still
--     reads their own removed text (see `comments_select`), which is what makes
--     "your post was hidden" explicable rather than gaslighting.
--   * Does not change any RLS policy. Visibility is already correct; only the
--     COUNTS were wrong.
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The single definition of "counted".
--
--    Deliberately WITHOUT a `set search_path` clause, unlike every other
--    function in this file. A `SET` clause blocks the planner from inlining a
--    SQL function, and this one is called per-row inside the backfill's join
--    conditions below. It also reads no schema objects at all — two parameters
--    and built-in operators — so there is no search_path surface to protect.
--    The triggers that call it are `security definer` with their own pinned
--    search_path, which is where that protection belongs.
-- ---------------------------------------------------------------------------
create or replace function public.is_counted_content(
  p_deleted_at     timestamptz,
  p_content_status text
) returns boolean
language sql
immutable
parallel safe
as $$
  select p_deleted_at is null and p_content_status = 'visible';
$$;

comment on function public.is_counted_content(timestamptz, text) is
  'Single source of truth for whether a post/comment row counts toward an '
  'engagement counter: not deleted AND not hidden by moderation. Used by the '
  'counter triggers and their backfill so the two cannot drift.';

-- ---------------------------------------------------------------------------
-- 2. INSERT / DELETE counters — widened from `deleted_at` to the full predicate.
--    Bodies otherwise identical to social_17, including `security definer`
--    (social_09: an RLS-gated UPDATE of ANOTHER user's counter row is silently
--    dropped without it) and the "only if it was still counted" DELETE guard
--    (social_17: a hard delete of an already-hidden row must not double-count).
-- ---------------------------------------------------------------------------
create or replace function public.tg_posts_author_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if public.is_counted_content(new.deleted_at, new.content_status) then
      update public.user_profiles set post_count = post_count + 1 where user_id = new.author_id;
    end if;
  elsif tg_op = 'DELETE' then
    if public.is_counted_content(old.deleted_at, old.content_status) then
      update public.user_profiles set post_count = greatest(post_count - 1, 0) where user_id = old.author_id;
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.tg_comments_post_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if public.is_counted_content(new.deleted_at, new.content_status) then
      update public.posts set comment_count = comment_count + 1 where id = new.post_id;
    end if;
  elsif tg_op = 'DELETE' then
    if public.is_counted_content(old.deleted_at, old.content_status) then
      update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
    end if;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The UPDATE transition — generalized from "soft delete" to "countability".
--
--    social_17 named these `tg_*_soft_delete` because `deleted_at` was the only
--    transition that existed. They now handle moderation hides and releases too,
--    so they are renamed rather than left lying about their scope; the old
--    names are dropped at the end of this section.
--
--    Computing both sides through `is_counted_content()` makes every transition
--    fall out automatically, including the ones easy to miss by hand:
--      visible -> pending    (soft-tier prefilter hit on a body edit)   -1
--      pending -> visible    (AI pass releasing a clean row)            +1
--      pending -> removed    (AI pass confirming, or report threshold)   0  <- no double-decrement
--      removed -> visible    (admin queue "keep" republishing)          +1
--      visible -> deleted    (author delete; unchanged from social_17)  -1
-- ---------------------------------------------------------------------------
create or replace function public.tg_posts_count_transition()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  was_counted boolean := public.is_counted_content(old.deleted_at, old.content_status);
  now_counted boolean := public.is_counted_content(new.deleted_at, new.content_status);
begin
  if was_counted and not now_counted then
    update public.user_profiles set post_count = greatest(post_count - 1, 0) where user_id = new.author_id;
  elsif now_counted and not was_counted then
    update public.user_profiles set post_count = post_count + 1 where user_id = new.author_id;
  end if;
  return null;
end;
$$;

create or replace function public.tg_comments_count_transition()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  was_counted boolean := public.is_counted_content(old.deleted_at, old.content_status);
  now_counted boolean := public.is_counted_content(new.deleted_at, new.content_status);
begin
  if was_counted and not now_counted then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = new.post_id;
  elsif now_counted and not was_counted then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  end if;
  return null;
end;
$$;

-- The WHEN clause compares the RAW columns rather than calling
-- `is_counted_content()` twice: it is strictly broader (fires on any change to
-- either axis) and leaves the decision in one place — the function body. A
-- no-op transition costs one function call and writes nothing.
drop trigger if exists posts_soft_delete_count on public.posts;
drop trigger if exists posts_count_transition on public.posts;
create trigger posts_count_transition
  after update on public.posts
  for each row
  when (old.deleted_at is distinct from new.deleted_at
        or old.content_status is distinct from new.content_status)
  execute function public.tg_posts_count_transition();

drop trigger if exists comments_soft_delete_count on public.comments;
drop trigger if exists comments_count_transition on public.comments;
create trigger comments_count_transition
  after update on public.comments
  for each row
  when (old.deleted_at is distinct from new.deleted_at
        or old.content_status is distinct from new.content_status)
  execute function public.tg_comments_count_transition();

-- Now unreferenced (the triggers above replaced their only call sites).
drop function if exists public.tg_posts_soft_delete();
drop function if exists public.tg_comments_soft_delete();

-- ---------------------------------------------------------------------------
-- 4. BACKFILL — repair counts already wrong.
--
--    Recomputed from the rows themselves rather than adjusted by a delta, so it
--    also absorbs drift from the social_09 RLS bug and the social_17 soft-delete
--    gap, not just this one. Same predicate as the triggers, by construction.
--
--    The `is distinct from` guard means only rows whose count is actually wrong
--    are written. That matters beyond efficiency: `set_updated_at` is a BEFORE
--    UPDATE trigger on both tables, so touching every row would bump every
--    `updated_at`. (The feed orders by `created_at`, so ordering is unaffected
--    either way — but an audit column should not record a migration as user
--    activity.) These UPDATEs write only counter columns, so they satisfy
--    neither new trigger's WHEN clause and cannot re-enter.
-- ---------------------------------------------------------------------------
with truth as (
  select p.id as post_id,
         count(c.id) as n
    from public.posts p
    left join public.comments c
      on c.post_id = p.id
     and public.is_counted_content(c.deleted_at, c.content_status)
   group by p.id
)
update public.posts p
   set comment_count = truth.n
  from truth
 where truth.post_id = p.id
   and p.comment_count is distinct from truth.n;

with truth as (
  select up.user_id,
         count(p.id) as n
    from public.user_profiles up
    left join public.posts p
      on p.author_id = up.user_id
     and public.is_counted_content(p.deleted_at, p.content_status)
   group by up.user_id
)
update public.user_profiles up
   set post_count = truth.n
  from truth
 where truth.user_id = up.user_id
   and up.post_count is distinct from truth.n;

-- ---------------------------------------------------------------------------
-- 5. A benign SOFT-tier test term.
--
--    social_05 seeded `zzblockedtest` (hard) so the auto-REMOVE path could be
--    exercised without typing a slur into the database. There has been no
--    equivalent for the soft tier, which meant testing the far more interesting
--    `pending -> AI pass -> visible` release path required posting real
--    profanity to staging. This closes that gap.
--
--    Alphabetic, so social_18's `\y` word-boundary matching anchors it the same
--    way it anchors every other term. The AI pass reads it as unremarkable text
--    and releases it, which is exactly the behaviour under test.
-- ---------------------------------------------------------------------------
insert into public.blocked_terms (term, severity) values
  ('zzsofttest', 'soft')
on conflict (term) do update set severity = excluded.severity;

commit;

-- ===========================================================================
-- VERIFY (run as service_role / in the SQL editor, after applying)
-- ===========================================================================
-- 1. No post's comment_count disagrees with its visible thread. Expect 0 rows:
--
--      select p.id, p.comment_count, count(c.id) as actual
--        from public.posts p
--        left join public.comments c
--          on c.post_id = p.id
--         and public.is_counted_content(c.deleted_at, c.content_status)
--       group by p.id, p.comment_count
--      having p.comment_count is distinct from count(c.id);
--
-- 2. Same for post_count. Expect 0 rows:
--
--      select up.user_id, up.post_count, count(p.id) as actual
--        from public.user_profiles up
--        left join public.posts p
--          on p.author_id = up.user_id
--         and public.is_counted_content(p.deleted_at, p.content_status)
--       group by up.user_id, up.post_count
--      having up.post_count is distinct from count(p.id);
--
-- 3. Both triggers exist with the widened condition. Expect 2 rows, each whose
--    action_condition mentions content_status:
--
--      select trigger_name, event_object_table, action_condition
--        from information_schema.triggers
--       where trigger_name in ('posts_count_transition', 'comments_count_transition');
--
-- 4. Live round trip — a hard-blocked comment must not move the count:
--
--      select comment_count from public.posts where id = '<post>';        -- before
--      insert into public.comments (post_id, author_id, body)
--        values ('<post>', '<author>', 'zzblockedtest');
--      select comment_count from public.posts where id = '<post>';        -- unchanged
-- ===========================================================================
