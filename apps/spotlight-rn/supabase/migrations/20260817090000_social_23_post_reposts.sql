-- Social layer — part 23: REPOST. Passing a post on is an ENDORSEMENT, not a
-- second copy of it.
--
-- NOT YET APPLIED anywhere. Apply to staging first.
--
-- ===========================================================================
-- WHY A JOIN TABLE AND NOT A NEW `posts` ROW
-- ===========================================================================
-- The obvious design — and the one docs/timeline-reshare-and-wishlist-sharing-
-- plan-2026-08-10.md proposed — is `posts.reshared_post_id`: a repost IS a post,
-- with a null body, pointing at its original. That is the QUOTE-repost shape,
-- and it is wrong for what a repost means here, on four counts:
--
--   1. The home feed is `fetchGlobalFeed` — every visible post, newest first,
--      for EVERYONE (there is no follow filter; `fetchFollowingFeed` exists and
--      has no caller). A repost row would therefore land in every reader's feed
--      beside the original, so the same post appears in the list twice. On a
--      follow-scoped feed that duplication is the entire point; on a global one
--      it is just noise.
--   2. `posts_author_count` (social_01) bumps `user_profiles.post_count` on
--      every INSERT. Your post count would inflate with things you did not
--      write.
--   3. Un-reposting would become a post soft-delete, entangled with the
--      `content_status = 'deleted'` client sentinel.
--   4. An empty-body post row has nothing for the moderation prefilter to read,
--      so it would travel through the pipeline meaning nothing.
--
-- `post_likes` (social_01) is the right template instead, and it dodges all four
-- by construction: composite PK, insert/delete only, no content of its own.
--
-- A repost is therefore exactly what a like is, structurally — one row per user
-- per post — and differs only in what the app DOES with it: the count is shown,
-- the author is notified, and the post is listed on the reposter's profile.
--
-- ===========================================================================
-- WHAT THIS BUYS LATER
-- ===========================================================================
-- These rows are precisely what a follow-scoped feed would read to answer "posts
-- from people I follow, INCLUDING what they passed on". Building the endorsement
-- now is the cheap half of that; nothing here has to change to get there.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
create table if not exists public.post_reposts (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- `post_likes` has NO user_id-only index, because nothing ever asks "what has
-- this person liked?" — the read is always "which of THESE posts did I like",
-- which the PK's leading column serves. A repost is asked the other question:
-- the profile Activity tab lists what this collector passed on, newest first.
create index if not exists idx_post_reposts_user
  on public.post_reposts (user_id, created_at desc);

alter table public.post_reposts enable row level security;

-- ---------------------------------------------------------------------------
-- RLS — copied from `post_likes` (social_01), deliberately unchanged
-- ---------------------------------------------------------------------------
-- Counts are public; you manage only your own row; you cannot repost a post
-- whose author has blocked you (or whom you have blocked).
--
-- The `exists` subquery runs under the CALLER's rights, so it is filtered by
-- `posts_select`. A post you cannot read yields no row and the insert is
-- rejected — it FAILS CLOSED, which is the property social_19 documents for the
-- like policy. There is no UPDATE policy: the row is insert/delete only, and
-- un-reposting is a delete.
drop policy if exists post_reposts_select on public.post_reposts;
create policy post_reposts_select on public.post_reposts for select to authenticated using (true);

drop policy if exists post_reposts_insert on public.post_reposts;
create policy post_reposts_insert on public.post_reposts for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from public.posts p where p.id = post_id and not public.is_blocked(auth.uid(), p.author_id)));

drop policy if exists post_reposts_delete on public.post_reposts;
create policy post_reposts_delete on public.post_reposts for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- The counter
-- ---------------------------------------------------------------------------
-- First column ever added to `posts` after its creation. Default 0 and a new
-- table means there is nothing to backfill.
alter table public.posts
  add column if not exists repost_count integer not null default 0;

-- DELIBERATELY THE social_09 SHAPE, NOT social_20's MODERATION-AWARE ONE.
--
-- social_20 made `comment_count` moderation-aware — guarded by
-- `is_counted_content` and repaired by a transition trigger — because a comment
-- carries its own `content_status` and can be hidden while its row still exists.
-- It explicitly left `like_count` alone, and gave the reason: a like row carries
-- no content_status, and likes are only reachable through content the user can
-- already see, so there is no axis to track. A repost row is a like row in every
-- respect that argument depends on. If the post it points at is hidden, nobody
-- can see the count, and it is simply unread.
--
-- `security definer set search_path = public, pg_temp` is MANDATORY, not
-- stylistic: reposting SOMEONE ELSE'S post fires a trigger that updates THEIR
-- row, and the `posts` UPDATE policy is author-only, so an invoker-rights
-- trigger has the counter bump SILENTLY dropped by RLS with no error. That is
-- the bug social_09 exists to fix.
create or replace function public.tg_post_reposts_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set repost_count = repost_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set repost_count = greatest(repost_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

drop trigger if exists post_reposts_count on public.post_reposts;
create trigger post_reposts_count after insert or delete on public.post_reposts
  for each row execute function public.tg_post_reposts_count();

-- ---------------------------------------------------------------------------
-- The notification
-- ---------------------------------------------------------------------------
-- A copy of `tg_notify_post_like` (social_21) with one word changed. NO DDL on
-- `notifications` is needed: `type` is unconstrained `text`, and
-- `uq_notifications_dedupe` (social_11) already spans
-- (recipient, actor, type, post, comment) — so repost → un-repost → re-repost
-- notifies exactly once, the same way a re-like does.
--
-- Three gates, in order, all inherited from the like trigger:
--   • the post is gone, or you are reposting yourself     → say nothing
--   • either of you has blocked the other                 → say nothing
--   • the post is deleted or not visible (social_21)      → say nothing about
--     engagement on content nobody can see
--
-- SECURITY DEFINER for the same two reasons as the like trigger: there is no
-- client INSERT policy on `notifications` at all (social_03), so an
-- invoker-rights function has every insert silently dropped; and the `select`
-- below must see the post's true state rather than whatever `posts_select`
-- would show the person who happened to fire it.
create or replace function public.tg_notify_post_repost()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  post_author  uuid;
  post_deleted timestamptz;
  post_status  text;
begin
  select author_id, deleted_at, content_status
    into post_author, post_deleted, post_status
    from public.posts where id = new.post_id;
  -- The post may already be gone; a missing author is not an error here.
  if post_author is null
     or post_author = new.user_id
     or public.is_blocked(new.user_id, post_author) then
    return null;
  end if;
  if not public.is_counted_content(post_deleted, post_status) then
    return null;
  end if;
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  values (post_author, new.user_id, 'repost', new.post_id)
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_notify_post_repost on public.post_reposts;
create trigger trg_notify_post_repost
  after insert on public.post_reposts
  for each row execute function public.tg_notify_post_repost();

comment on table public.post_reposts is
  'One row per user per post they passed on. An endorsement, not a copy: nothing is republished, so nothing can outlive the original. Drives posts.repost_count and the reposter profile Activity list.';
comment on column public.posts.repost_count is
  'Maintained by tg_post_reposts_count. Not moderation-aware, for the same reason like_count is not (social_20): a repost row carries no content_status.';
