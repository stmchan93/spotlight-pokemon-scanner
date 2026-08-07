-- Social layer — part 11: populate `notifications` from engagement.
--
-- The table, its indexes, and its RLS have existed since social_03, but NOTHING
-- has ever written to it — no trigger, no worker. This migration is the writer.
--
-- WHY TRIGGERS AND NOT A WORKER
--   The rows must appear in the same transaction as the like/comment/follow that
--   caused them, or a notification can go missing when a worker dies between the
--   engagement write and the notify write. Triggers also need no new infra, and
--   this codebase already reaches for them for exactly this shape of derived
--   write (social_01 counters, social_07/social_09 hardening).
--
-- WHY `security definer` — the same bug social_07 and social_09 fixed twice
--   `notifications` has NO client INSERT policy by design ("notifications are
--   created server-side (service role bypasses RLS)"). A trigger function runs as
--   the INVOKING user unless marked definer, so an invoker-rights trigger here
--   would have every insert SILENTLY DROPPED by RLS — no error, no notification,
--   exactly the failure mode social_09 documents for the counters. Marking these
--   definer is what makes them able to write at all.
--
--   `set search_path = public, pg_temp` is not decoration: a definer function
--   without a pinned search_path can be hijacked via a temp-schema shadow of any
--   object it names.
--
-- SELF-ACTION IS NOT A NOTIFICATION
--   Liking or commenting on your own post must not notify you. Each trigger
--   returns early when actor = recipient. (`follows` already enforces this with a
--   `check (follower_id <> followee_id)`, but the guard is kept for symmetry so
--   the rule reads the same in all four functions.)
--
-- NO DELETE HANDLING, DELIBERATELY
--   Unlike the counter triggers these are INSERT-only. Un-liking should not
--   retract a notification you may already have read — the event genuinely
--   happened. The re-notify churn from like/unlike/like is bounded by the dedupe
--   index below.
--
-- DEDUPE
--   `uq_notifications_dedupe` stops the same actor generating an unbounded stream
--   of identical rows by toggling a like. `on conflict do nothing` makes a repeat
--   a no-op instead of an error, so it can never fail the engagement write that
--   triggered it. Comment notifications are NOT deduped on comment_id being
--   distinct — each separate comment is a real, separate event.
--
-- Additive and transactional: creates one index and four functions/triggers.
-- Touches no existing table, policy, or RLS rule.

begin;

-- ---------------------------------------------------------------------------
-- Dedupe key
-- ---------------------------------------------------------------------------
-- A like carries no per-event id, so (recipient, actor, type, post, comment)
-- identifies it. COALESCE because post_id/comment_id are nullable and NULLs
-- don't compare equal in a unique index — without it every row would be
-- "distinct" and the dedupe would silently never fire.
create unique index if not exists uq_notifications_dedupe
  on public.notifications (
    recipient_id,
    actor_id,
    type,
    coalesce(post_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ---------------------------------------------------------------------------
-- follow → notify the followee
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_follow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.follower_id = new.followee_id then
    return null;
  end if;
  insert into public.notifications (recipient_id, actor_id, type)
  values (new.followee_id, new.follower_id, 'follow')
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_notify_follow on public.follows;
create trigger trg_notify_follow
  after insert on public.follows
  for each row execute function public.tg_notify_follow();

-- ---------------------------------------------------------------------------
-- post like → notify the post's author
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_post_like()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  post_author uuid;
begin
  select author_id into post_author from public.posts where id = new.post_id;
  -- The post may already be gone; a missing author is not an error here.
  if post_author is null or post_author = new.user_id then
    return null;
  end if;
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  values (post_author, new.user_id, 'like', new.post_id)
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_notify_post_like on public.post_likes;
create trigger trg_notify_post_like
  after insert on public.post_likes
  for each row execute function public.tg_notify_post_like();

-- ---------------------------------------------------------------------------
-- comment like → notify the comment's author
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_comment_like()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  comment_author uuid;
  parent_post    uuid;
begin
  select author_id, post_id into comment_author, parent_post
    from public.comments where id = new.comment_id;
  if comment_author is null or comment_author = new.user_id then
    return null;
  end if;
  -- post_id is carried so the client can deep-link straight to the thread.
  insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
  values (comment_author, new.user_id, 'like', parent_post, new.comment_id)
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_notify_comment_like on public.comment_likes;
create trigger trg_notify_comment_like
  after insert on public.comment_likes
  for each row execute function public.tg_notify_comment_like();

-- ---------------------------------------------------------------------------
-- comment → notify the post author, and the parent comment's author on a reply
-- ---------------------------------------------------------------------------
-- A reply to a comment on someone else's post can legitimately produce TWO
-- notifications (post author + parent-comment author). They differ by
-- recipient_id, so the dedupe index does not collapse them.
create or replace function public.tg_notify_comment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  post_author   uuid;
  parent_author uuid;
begin
  select author_id into post_author from public.posts where id = new.post_id;

  if post_author is not null and post_author <> new.author_id then
    insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
    values (post_author, new.author_id, 'comment', new.post_id, new.id)
    on conflict do nothing;
  end if;

  if new.parent_comment_id is not null then
    select author_id into parent_author
      from public.comments where id = new.parent_comment_id;
    -- Skip when the parent's author is the poster we just notified, or is the
    -- replier themselves — one event should never notify anyone twice.
    if parent_author is not null
       and parent_author <> new.author_id
       and parent_author is distinct from post_author then
      insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
      values (parent_author, new.author_id, 'comment', new.post_id, new.id)
      on conflict do nothing;
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_notify_comment on public.comments;
create trigger trg_notify_comment
  after insert on public.comments
  for each row execute function public.tg_notify_comment();

commit;
