-- Social layer — part 21: make the NOTIFICATION triggers aware of `content_status`.
--
-- ===========================================================================
-- 1. THE BUG
-- ===========================================================================
-- Reported live: a user posted a comment containing the seeded hard-tier test
-- term `zzblockedtest`. `tg_content_prefilter` is BEFORE INSERT, so the row
-- landed with `content_status = 'removed'` and was correctly invisible to
-- everyone but its author. The post's author still got a notification — and it
-- rendered BLANK.
--
-- Blank, specifically, because of how the two halves disagree:
--
--   * `tg_notify_comment()` (social_11, re-created by social_19) fires AFTER
--     INSERT on `comments` unconditionally. `content_status` appears NOWHERE in
--     social_11 — the word is not in the file.
--   * `comments_select` (social_01, restated by social_17) returns a
--     non-'visible' comment to its AUTHOR and to admins ONLY.
--
-- So the notification row points at a `comment_id` that RLS refuses to return
-- to the recipient. `fetchNotifications` (social-service.ts) hydrates comment
-- bodies with one batched `in (...)` read and deliberately degrades rather than
-- drops when hydration comes back empty ("a notification is a real event
-- regardless of whether its context resolves"). That degradation is right for a
-- transient miss and wrong here: the read can NEVER succeed, so the row is a
-- permanent empty line with an unread badge behind it.
--
-- THIS IS THE FOURTH INSTANCE OF ONE BUG CLASS in this schema:
--
--   social_09  counter writes silently dropped by RLS (missing `security definer`)
--   social_17  counters blind to the `deleted_at` axis
--   social_20  counters blind to the `content_status` axis
--   social_21  NOTIFICATIONS blind to the `content_status` axis   <- this file
--
-- Every one of them is the same shape: a derived write that re-states, or
-- forgets, the predicate for "is this content real?". social_20 responded by
-- naming the predicate ONCE, in `public.is_counted_content()`. This file's whole
-- job is to call that function rather than invent a fifth version of it.
--
-- ===========================================================================
-- 2. THE AUDIT — all four notify triggers, not just the reported one
-- ===========================================================================
-- `tg_notify_follow`      NOT CHANGED. `follows` is an edge between two users;
--                         it carries no body, no `content_status`, and no
--                         `deleted_at`. There is no hidden-content axis to be
--                         blind to. Left byte-identical to social_19 so a diff
--                         of this file shows only what actually moved.
--
-- `tg_notify_post_like`   CHANGED. Gated on the LIKED POST being visible.
--                         Reachable today only via an admin (`posts_select` has
--                         an `is_admin()` branch) or the service role, because a
--                         hidden post is unreadable to everyone else and
--                         `post_likes_insert` re-checks `posts` under the
--                         caller's RLS; the author's own like short-circuits on
--                         the self-action guard before reaching a notification.
--                         Gated anyway: "unreachable through today's policies"
--                         is exactly the assumption social_09 and social_20 both
--                         had to walk back.
--
-- `tg_notify_comment_like` CHANGED, and this one IS reachable by an ordinary
--                         user. `comments_select` has carried a TOMBSTONE branch
--                         since social_17: a soft-deleted comment stays readable
--                         to everyone while a live reply hangs off it, so anyone
--                         can like a comment whose author deleted it, and the
--                         author gets pinged about engagement on content they
--                         removed. Note the notification itself is NOT blank
--                         here — it points at the recipient's OWN comment, which
--                         the author branch of `comments_select` always returns.
--                         It is suppressed because advertising engagement on
--                         withdrawn or moderated content is wrong, not because
--                         it fails to render.
--
-- `tg_notify_comment`     CHANGED — the reported bug, plus two more gates found
--                         by asking the same question of every id the function
--                         touches:
--                           a. the NEW COMMENT itself (the reported bug — this
--                              is the one that renders blank, because the
--                              recipient is never its author);
--                           b. the PARENT POST — do not ring a post's author
--                              about a thread underneath content that is itself
--                              hidden;
--                           c. the PARENT COMMENT on a reply — same tombstone
--                              path as `tg_notify_comment_like`: you can reply
--                              under a deleted or removed comment, and its
--                              author should not be notified about it.
--
-- ===========================================================================
-- 3. THE RELEASE PATH — the subtle half, and why suppression alone is a bug
-- ===========================================================================
-- A soft-tier comment inserts as 'pending', not 'removed'. It is invisible to
-- everyone but its author until the async AI pass
-- (backend/social_moderation_worker.py) clears it back to 'visible'.
--
-- If insert-time notification is simply suppressed and nothing else changes,
-- that comment goes live and the post owner is NEVER told. The author sees
-- their comment sitting in the thread; the owner never replies; nobody can tell
-- from the outside that anything was dropped. That is strictly worse than the
-- blank notification this file exists to remove — a blank row at least admits
-- something happened.
--
-- DECISION: NOTIFY ON THE pending -> visible TRANSITION.
--
-- Three reasons, in order of weight:
--
--   1. It is the rule social_20 already committed this schema to. There, "the
--      count follows visibility": `tg_comments_count_transition` increments on
--      release rather than at insert. A notification is derived from exactly the
--      same event as the counter, so it must key off exactly the same moment, or
--      the thread's comment_count and the owner's notification list disagree
--      about whether the comment exists. One rule, two consumers.
--
--   2. The timing is CORRECT, not merely convenient. The notification's job is
--      "someone said something you can go and read." That becomes true at
--      release, not at insert. Firing at insert would deep-link the owner into a
--      thread where the comment is not there yet.
--
--   3. It is safe to fire twice, so it cannot double-ping. social_11's
--      `uq_notifications_dedupe` is exactly
--      `(recipient_id, actor_id, type, coalesce(post_id,…), coalesce(comment_id,…))`
--      and every insert here is `on conflict do nothing`. A release after a
--      notification already exists is a no-op, which also makes the DELETE in
--      section 5 safe: a row removed there is re-created if and only if the
--      comment is genuinely released later.
--
-- Mechanically: `tg_notify_comment()` now serves TWO triggers and branches on
-- `tg_op`. It has to be two triggers rather than one `after insert or update` —
-- Postgres rejects a WHEN clause referencing OLD on a trigger that also covers
-- INSERT — but it is deliberately ONE function body, because duplicating the
-- two-recipient reply logic is how the next drift gets introduced.
--
-- The UPDATE branch fires only on a transition INTO countable, so an ordinary
-- edit, a like_count bump, or the AI pass stamping `moderation_checked_at` on an
-- already-visible row notifies nobody.
--
-- WHAT DELIBERATELY HAS NO RELEASE PATH, and why that is not the same omission:
--   * A LIKE suppressed because its target was hidden. To like hidden content
--     you must be able to see it, which means you are its author (self-action,
--     never notified) or an admin. There is no ordinary-user path to a
--     suppressed like, so there is nothing to release. Building a
--     likes-replay-on-release scan would mean re-reading every like of a comment
--     on every status change to buy back a case only an admin can create.
--   * A COMMENT suppressed because its PARENT POST was hidden. Same argument:
--     only the post's own author (self-action) or an admin can comment on a
--     hidden post. If group posting or a moderator-comment feature ever changes
--     that, the fix is a `posts` transition trigger shaped exactly like the
--     `comments` one below.
--   * The `deleted_at` axis is NOT replayed. Restoring a soft-deleted comment
--     hits the same transition trigger, but its notification was already
--     generated at insert (it was visible then), so the dedupe index makes the
--     re-insert a no-op. Correct by construction rather than by special case.
--
-- ===========================================================================
-- 4. WHAT THIS FILE DOES NOT DO
-- ===========================================================================
--   * Does not add DELETE handling to the notify triggers. social_11's rule
--     stands: "un-liking should not retract a notification you may already have
--     read — the event genuinely happened." Suppressing a notification that was
--     never legitimate is a different act from retracting one that was.
--   * Does not touch `tg_notify_follow`, for the reason in section 2.
--   * Does not change any RLS policy. `notifications_select` keeps social_19's
--     block filter exactly as written. The defect was in what got GENERATED,
--     never in what got returned.
--   * Does not touch the counters. social_20 owns those and they are correct.
--   * Does not need anything from the moderation worker: the release path is
--     LIVE, not dormant. `_moderate_text_table()` in
--     `backend/social_moderation_worker.py` already writes
--     `content_status = 'visible'` for a clean `pending` row with no open
--     report (see its `outcome = "released"` branch), and staging's
--     `~/spotlight/logs/social_moderation.log` shows it firing:
--
--         00:06:03 INFO comments 69c63357-... -> released
--
--     BEWARE the header comment in social_18, which says the worker is not on
--     cron and never un-hides. Both halves were true when it was written and are
--     false now — the cron is installed by `deploy_to_vm.sh` and runs every two
--     minutes on both environments. Verify against the worker source and the VM
--     log, never against that comment. The same stale note is what made an
--     earlier draft of THIS file claim the trigger below was dormant.
--   * Does not rename `is_counted_content()`. Its name says "counted" and it is
--     now also "notifiable", which is a small lie of omission — but renaming a
--     function three migrations after it shipped, to fix a comment, trades a
--     real re-application risk for a cosmetic one. The COMMENT on it is widened
--     below instead, and the function body is not touched at all.
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 0. Widen what `is_counted_content()` is documented to mean.
--
--    The BODY IS NOT TOUCHED — this is a `comment on`, nothing else. social_20
--    created it as the single definition of "is this content real?" precisely so
--    a second consumer would not fork it; this file is that second consumer, and
--    the docstring should say so rather than leaving the next reader to think
--    notifications have their own rule somewhere.
-- ---------------------------------------------------------------------------
comment on function public.is_counted_content(timestamptz, text) is
  'Single source of truth for whether a post/comment row is REAL: not deleted '
  'AND not hidden by moderation. Used by the engagement counter triggers and '
  'their backfill (social_20) and by the notification triggers (social_21), so '
  'counts, visibility and notifications cannot drift apart.';

-- ---------------------------------------------------------------------------
-- 1. post like -> notify the post's author.
--
--    social_19 verbatim apart from reading two more columns and one added gate.
--    KEEPS `security definer set search_path` — social_11 is emphatic about why:
--    `notifications` has no client INSERT policy, so an invoker-rights trigger
--    here has every insert SILENTLY DROPPED by RLS.
--
--    Definer also means the `select` below bypasses `posts_select` and sees the
--    row's true state, which is what makes the gate trustworthy rather than
--    dependent on who happened to fire the trigger.
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_post_like()
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
  -- social_21: no notification for engagement on content nobody can see.
  if not public.is_counted_content(post_deleted, post_status) then
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
-- 2. comment like -> notify the comment's author.
--
--    The reachable one (section 2 of the header): `comments_select`'s tombstone
--    branch lets anyone like a comment its author deleted.
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_comment_like()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  comment_author  uuid;
  parent_post     uuid;
  comment_deleted timestamptz;
  comment_status  text;
begin
  select author_id, post_id, deleted_at, content_status
    into comment_author, parent_post, comment_deleted, comment_status
    from public.comments where id = new.comment_id;
  if comment_author is null
     or comment_author = new.user_id
     or public.is_blocked(new.user_id, comment_author) then
    return null;
  end if;
  -- social_21: a deleted or moderation-hidden comment does not earn its author
  -- a ping, even though the author could still read it.
  if not public.is_counted_content(comment_deleted, comment_status) then
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
-- 3. comment -> notify the post author, and the parent comment's author on a
--    reply. THE REPORTED BUG, plus the release path.
--
--    One function, two triggers (AFTER INSERT below, AFTER UPDATE after it).
--    `tg_op` is the only thing that differs, and it differs in exactly one
--    place: the "was it already notifiable?" early return.
--
--    Gate order is deliberate — the comment's own visibility is checked FIRST,
--    before any lookup, because it is the common case and needs no query.
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_comment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  post_author     uuid;
  post_deleted    timestamptz;
  post_status     text;
  parent_author   uuid;
  parent_deleted  timestamptz;
  parent_status   text;
begin
  -- GATE A — the comment itself. This is the reported bug: the recipient is
  -- never this comment's author, so a hidden comment yields a notification that
  -- RLS guarantees can never be hydrated.
  if not public.is_counted_content(new.deleted_at, new.content_status) then
    return null;
  end if;

  -- On UPDATE, only the moment the comment BECOMES notifiable is an event. An
  -- edit, a restore of an already-visible row, or any other update of a row that
  -- was notifiable all along must not re-notify. (The dedupe index would absorb
  -- a duplicate anyway; this makes the intent explicit rather than relying on a
  -- unique constraint to express policy.)
  --
  -- NESTED, not `tg_op = 'UPDATE' and is_counted_content(old...)`. PL/pgSQL
  -- evaluates a condition as one SQL expression with OLD substituted as a
  -- parameter, and SQL's AND does not promise short-circuit — so the flat form
  -- raises `record "old" is not assigned yet` on the INSERT trigger, which is
  -- every ordinary comment.
  if tg_op = 'UPDATE' then
    if public.is_counted_content(old.deleted_at, old.content_status) then
      return null;
    end if;
  end if;

  select author_id, deleted_at, content_status
    into post_author, post_deleted, post_status
    from public.posts where id = new.post_id;

  -- GATE B — the parent post. Nobody is told about a thread growing underneath
  -- content that is itself hidden.
  if post_author is not null
     and post_author <> new.author_id
     and public.is_counted_content(post_deleted, post_status)
     and not public.is_blocked(new.author_id, post_author) then
    insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
    values (post_author, new.author_id, 'comment', new.post_id, new.id)
    on conflict do nothing;
  end if;

  if new.parent_comment_id is not null then
    select author_id, deleted_at, content_status
      into parent_author, parent_deleted, parent_status
      from public.comments where id = new.parent_comment_id;
    -- Skip when the parent's author is the poster we just notified, or is the
    -- replier themselves — one event should never notify anyone twice.
    --
    -- GATE C — the parent comment. You can reply under a tombstoned comment
    -- (social_17 keeps it readable so the replies keep their parent); its author
    -- is not pinged for a comment they deleted, or one moderation removed.
    if parent_author is not null
       and parent_author <> new.author_id
       and parent_author is distinct from post_author
       and public.is_counted_content(parent_deleted, parent_status)
       and not public.is_blocked(new.author_id, parent_author) then
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

-- THE RELEASE PATH (header section 3). The WHEN clause compares the RAW columns
-- rather than calling `is_counted_content()` twice — strictly broader, and it
-- leaves the decision in one place, the function body. Shaped identically to
-- social_20's `comments_count_transition` on purpose: the count and the
-- notification are derived from the same event and must react to the same
-- transitions, so the two trigger definitions should be readable side by side.
drop trigger if exists comments_notify_transition on public.comments;
create trigger comments_notify_transition
  after update on public.comments
  for each row
  when (old.deleted_at is distinct from new.deleted_at
        or old.content_status is distinct from new.content_status)
  execute function public.tg_notify_comment();

-- ---------------------------------------------------------------------------
-- 4. CLEANUP — the blank notifications this bug already generated.
--
--    Scope, stated precisely: `type = 'comment'` rows pointing at a comment that
--    is not 'visible', where the recipient is not that comment's author. Those
--    are, by construction, rows `comments_select` can never return to their
--    recipient — a permanent empty line carrying an unread badge that clearing
--    does not make meaningful.
--
--    WHY DELETE, when social_19 chose to FILTER its equivalent rows. There, the
--    hidden state was a BLOCK: reversible, and the row was evidence in a dispute
--    the abuse queue might have to judge. Here the row is evidence of nothing.
--    The moderation record lives in `comments` (body and `content_status` both
--    retained — social_20 is explicit that a removed comment must not be
--    rewritten into a tombstone) and in `moderation_actions`; the notification
--    is a pure UI artifact of a trigger that ran too early. Filtering it in
--    `notifications_select` instead would buy a permanent correlated subquery on
--    every notification read, forever, to preserve rows nobody can render.
--
--    DELIBERATELY NOT DELETED:
--      * anything keyed on `deleted_at`. social_11 chose not to retract
--        notifications for content that later went away, and that choice is not
--        this file's to reverse. Generation is now gated on BOTH axes; retraction
--        is a one-off repair of the `content_status` axis only — the one no
--        migration has ever handled.
--      * `type = 'like'` rows. Their `comment_id`/`post_id` points at the
--        RECIPIENT'S OWN content, which the author branch of
--        `comments_select`/`posts_select` always returns, so they render.
--
--    ACCEPTED OVERREACH, named rather than hidden: a comment that was visible,
--    legitimately notified, and only later removed by the AI pass or the report
--    threshold also loses its notification here. The row is unrenderable today
--    either way, so keeping it preserves nothing the recipient can reach. And a
--    'pending' comment later RELEASED re-acquires its notification through the
--    transition trigger above, which is precisely why deleting is safe.
--
--    Idempotent: re-running deletes nothing the first pass left behind.
-- ---------------------------------------------------------------------------
delete from public.notifications n
 using public.comments c
 where n.comment_id = c.id
   and n.type = 'comment'
   and c.content_status <> 'visible'
   and n.recipient_id <> c.author_id;

commit;

-- ===========================================================================
-- VERIFY (run as service_role / in the SQL editor, after applying)
-- ===========================================================================
-- 1. No notification points at a comment its recipient cannot read.
--    Expect 0 rows:
--
--      select n.id, n.type, n.recipient_id, c.content_status
--        from public.notifications n
--        join public.comments c on c.id = n.comment_id
--       where n.type = 'comment'
--         and c.content_status <> 'visible'
--         and n.recipient_id <> c.author_id;
--
-- 2. All three comment triggers exist, and the release one carries the widened
--    condition. Expect 2 rows on `comments` — `trg_notify_comment` (INSERT, no
--    condition) and `comments_notify_transition` (UPDATE, action_condition
--    mentioning content_status):
--
--      select trigger_name, event_manipulation, action_condition
--        from information_schema.triggers
--       where event_object_table = 'comments'
--         and trigger_name in ('trg_notify_comment', 'comments_notify_transition')
--       order by trigger_name, event_manipulation;
--
-- 3. Every notify function is still SECURITY DEFINER with a pinned search_path.
--    Expect 4 rows, all prosecdef = true and proconfig containing search_path —
--    losing either silently stops ALL notifications (social_11):
--
--      select proname, prosecdef, proconfig
--        from pg_proc
--       where pronamespace = 'public'::regnamespace
--         and proname in ('tg_notify_follow', 'tg_notify_post_like',
--                         'tg_notify_comment_like', 'tg_notify_comment');
--
-- 4. Live round trip — a HARD-blocked comment must notify nobody. Substitute a
--    real post id and an author id that is NOT the post's author:
--
--      select count(*) from public.notifications where post_id = '<post>';  -- before
--      insert into public.comments (post_id, author_id, body)
--        values ('<post>', '<other author>', 'zzblockedtest')
--        returning id, content_status;                                      -- 'removed'
--      select count(*) from public.notifications where post_id = '<post>';  -- unchanged
--
-- 5. Live round trip — the RELEASE path. A SOFT-blocked comment notifies nobody
--    at insert, and notifies exactly once when the AI pass releases it:
--
--      insert into public.comments (post_id, author_id, body)
--        values ('<post>', '<other author>', 'zzsofttest')
--        returning id, content_status;                                      -- 'pending'
--      select count(*) from public.notifications where comment_id = '<new comment>';  -- 0
--      update public.comments set content_status = 'visible' where id = '<new comment>';
--      select count(*) from public.notifications where comment_id = '<new comment>';  -- 1
--      -- and re-releasing cannot double-ping (uq_notifications_dedupe):
--      update public.comments set content_status = 'removed' where id = '<new comment>';
--      update public.comments set content_status = 'visible' where id = '<new comment>';
--      select count(*) from public.notifications where comment_id = '<new comment>';  -- still 1
--
-- 6. Control — an ordinary comment still notifies. If this regresses, the file
--    has turned the notification system off rather than narrowed it:
--
--      insert into public.comments (post_id, author_id, body)
--        values ('<post>', '<other author>', 'nice pull, congrats')
--        returning id;
--      select count(*) from public.notifications where comment_id = '<new comment>';  -- 1
-- ===========================================================================
