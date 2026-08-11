-- pgTAP — notifications must follow VISIBILITY, not merely "a row was inserted".
--
-- Regression tests for the bug fixed by
-- 20260815090000_social_21_moderation_aware_notifications.sql: before it,
-- `tg_notify_comment()` fired on every AFTER INSERT regardless of
-- `content_status`, so a comment the pre-filter had already set to 'removed'
-- still notified the post's author — and the notification rendered BLANK,
-- because `comments_select` returns a non-'visible' comment only to its own
-- author and to admins, so `fetchNotifications` could never hydrate it.
--
-- The rule, reusing social_20's single definition:
--     notifiable  <=>  public.is_counted_content(deleted_at, content_status)
--
-- applied to the comment itself, to its parent post, and to the parent comment
-- of a reply — plus the same predicate on the target of a like.
--
-- The pending -> visible RELEASE path is the other half and is asserted here
-- too: suppressing a soft-tier comment's notification at insert and never
-- firing it again would silently swallow the notification for a comment that
-- goes on to be published.
--
-- `supabase test db` runs as `postgres`, so RLS is bypassed throughout. That is
-- what lets this file exercise paths (liking hidden content, commenting on a
-- hidden post) that policies make hard to reach as an ordinary user — which is
-- the point: the triggers must be correct on their own, not only because some
-- policy happens to stand in front of them.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;
set local search_path to public, extensions, pg_temp;
create extension if not exists pgtap;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
create temporary table ids (k text primary key, v uuid) on commit drop;

create function pg_temp.newid(p_key text) returns uuid
language plpgsql as $fn$
declare v_id uuid := gen_random_uuid();
begin
  insert into pg_temp.ids (k, v) values (p_key, v_id);
  return v_id;
end;
$fn$;

create function pg_temp.uid(p_key text) returns uuid
language sql stable as $fn$ select v from pg_temp.ids where k = p_key $fn$;

-- Creates a real auth.users row. The social_14 AFTER INSERT trigger seeds
-- `user_profiles` and the social_10 trigger mirrors the id into `public.users`;
-- the explicit upsert is a belt-and-braces so nothing here silently depends on
-- profile seeding.
create function pg_temp.mk_user(p_label text) returns uuid
language plpgsql as $fn$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    p_label || '.' || replace(v_id::text, '-', '') || '@moderation.test',
    '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', p_label),
    now(), now()
  );
  insert into public.user_profiles (user_id, display_name)
  values (v_id, p_label)
  on conflict (user_id) do nothing;
  insert into pg_temp.ids (k, v) values (p_label, v_id);
  return v_id;
end;
$fn$;

-- Every notification pointing at a comment, whoever the recipient is. This is
-- the assertion that catches "it notified SOMEBODY about hidden content".
create function pg_temp.n_by_comment(p_comment uuid) returns integer
language sql stable as $fn$
  select count(*)::int from public.notifications where comment_id = p_comment
$fn$;

-- Notifications a specific recipient got about a specific comment.
create function pg_temp.n_for(p_recipient uuid, p_comment uuid) returns integer
language sql stable as $fn$
  select count(*)::int from public.notifications
   where recipient_id = p_recipient and comment_id = p_comment
$fn$;

-- Post-like notifications carry a post but no comment.
create function pg_temp.n_post_like(p_recipient uuid, p_post uuid) returns integer
language sql stable as $fn$
  select count(*)::int from public.notifications
   where recipient_id = p_recipient
     and type = 'like'
     and post_id = p_post
     and comment_id is null
$fn$;

create function pg_temp.n_follow(p_recipient uuid, p_actor uuid) returns integer
language sql stable as $fn$
  select count(*)::int from public.notifications
   where recipient_id = p_recipient and actor_id = p_actor and type = 'follow'
$fn$;

-- `perform` inside a DO block rather than a bare `select`: pg_prove pipes psql
-- output straight into the TAP parser, so a fixture call must emit no rows.
do $do$ begin
  perform pg_temp.mk_user('poster');
  perform pg_temp.mk_user('commenter');
  perform pg_temp.mk_user('replier');
  perform pg_temp.mk_user('liker');
  perform pg_temp.mk_user('follower');
end $do$;

-- One statement per row: `newid()` writes to pg_temp.ids, and a later row in the
-- same statement must never have to read what an earlier row wrote.
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_ok'), pg_temp.uid('poster'), 'a perfectly ordinary charizard pull');
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_hidden'), pg_temp.uid('poster'), 'zzblockedtest');

-- ---------------------------------------------------------------------------
-- 1. CONTROL — an ordinary comment must still notify the post's author.
--    Asserted first: every other case in this file narrows notification
--    generation, and a file that narrowed it to nothing would still pass them.
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_ok'), pg_temp.uid('p_ok'), pg_temp.uid('commenter'), 'nice pull, congrats');

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_ok')),
  'visible',
  'guard: an ordinary comment inserts as visible'
);

select is(
  pg_temp.n_for(pg_temp.uid('poster'), pg_temp.uid('c_ok')), 1,
  'CONTROL: an ordinary comment notifies the post author exactly once'
);

-- ---------------------------------------------------------------------------
-- 2. REGRESSION — a HARD-blocked comment must notify nobody.
--    This is the reported bug: the recipient is the post author, who is not the
--    comment's author, so RLS can never return the comment and the row renders
--    as a blank line.
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_hard'), pg_temp.uid('p_ok'), pg_temp.uid('commenter'), 'zzblockedtest');

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_hard')),
  'removed',
  'guard: the HARD-term comment really did insert as removed'
);

select is(
  pg_temp.n_by_comment(pg_temp.uid('c_hard')), 0,
  'REGRESSION: a comment auto-removed by the prefilter notifies NOBODY'
);

-- ---------------------------------------------------------------------------
-- 3. A SOFT-blocked ('pending') comment is also silent at insert — it is
--    invisible to every reader but its author until the AI pass clears it.
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_soft'), pg_temp.uid('p_ok'), pg_temp.uid('commenter'), 'zzsofttest');

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_soft')),
  'pending',
  'guard: the SOFT-term comment really did insert as pending'
);

select is(
  pg_temp.n_by_comment(pg_temp.uid('c_soft')), 0,
  'a pending comment notifies nobody while it is still hidden'
);

-- ---------------------------------------------------------------------------
-- 4. THE RELEASE PATH — pending -> visible must notify.
--    Without this, suppression at insert would mean a released comment goes
--    live and its post owner is never told. Only content_status is in the SET
--    list, so the BEFORE UPDATE OF body prefilter does not re-fire.
-- ---------------------------------------------------------------------------
update public.comments set content_status = 'visible' where id = pg_temp.uid('c_soft');

select is(
  pg_temp.n_for(pg_temp.uid('poster'), pg_temp.uid('c_soft')), 1,
  'RELEASE: pending -> visible (the AI pass clearing a row) notifies the post author'
);

select is(
  (select actor_id from public.notifications where comment_id = pg_temp.uid('c_soft')),
  pg_temp.uid('commenter'),
  'the released notification names the comment author as the actor'
);

-- Re-releasing must not double-ping. The insert is `on conflict do nothing`
-- against social_11's uq_notifications_dedupe, which is also what makes the
-- migration's cleanup DELETE safe.
update public.comments set content_status = 'removed' where id = pg_temp.uid('c_soft');
update public.comments set content_status = 'visible' where id = pg_temp.uid('c_soft');

select is(
  pg_temp.n_by_comment(pg_temp.uid('c_soft')), 1,
  'a removed -> visible round trip does not generate a second notification'
);

-- ---------------------------------------------------------------------------
-- 5. social_11 behaviour that must survive: commenting on your own post is not
--    a notification.
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_self'), pg_temp.uid('p_ok'), pg_temp.uid('poster'), 'bumping my own thread');

select is(
  pg_temp.n_by_comment(pg_temp.uid('c_self')), 0,
  'commenting on your own post still notifies nobody (social_11)'
);

-- ---------------------------------------------------------------------------
-- 6. Replies: two recipients on the happy path, zero when the reply is hidden.
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, parent_comment_id, body)
values (pg_temp.newid('c_reply'), pg_temp.uid('p_ok'), pg_temp.uid('replier'),
        pg_temp.uid('c_ok'), 'agreed, that centering is clean');

select is(
  pg_temp.n_for(pg_temp.uid('poster'), pg_temp.uid('c_reply')), 1,
  'CONTROL: a reply notifies the post author'
);

select is(
  pg_temp.n_for(pg_temp.uid('commenter'), pg_temp.uid('c_reply')), 1,
  'CONTROL: a reply also notifies the parent comment author'
);

insert into public.comments (id, post_id, author_id, parent_comment_id, body)
values (pg_temp.newid('c_reply_hard'), pg_temp.uid('p_ok'), pg_temp.uid('replier'),
        pg_temp.uid('c_ok'), 'zzblockedtest');

select is(
  pg_temp.n_by_comment(pg_temp.uid('c_reply_hard')), 0,
  'REGRESSION: a hidden reply notifies NEITHER the post author nor the parent author'
);

-- ---------------------------------------------------------------------------
-- 7. Likes: the target's visibility gates the notification.
--    A like on a hidden comment does not render blank (the recipient is the
--    comment's own author, who can always read it) — it is suppressed because
--    engagement on content nobody else can see is not news.
-- ---------------------------------------------------------------------------
insert into public.comment_likes (comment_id, user_id)
values (pg_temp.uid('c_ok'), pg_temp.uid('liker'));

select is(
  pg_temp.n_for(pg_temp.uid('commenter'), pg_temp.uid('c_ok')), 1,
  'CONTROL: liking a visible comment notifies its author'
);

insert into public.comment_likes (comment_id, user_id)
values (pg_temp.uid('c_hard'), pg_temp.uid('liker'));

select is(
  pg_temp.n_by_comment(pg_temp.uid('c_hard')), 0,
  'liking a hidden comment notifies nobody'
);

insert into public.post_likes (post_id, user_id)
values (pg_temp.uid('p_ok'), pg_temp.uid('liker'));

select is(
  pg_temp.n_post_like(pg_temp.uid('poster'), pg_temp.uid('p_ok')), 1,
  'CONTROL: liking a visible post notifies its author'
);

insert into public.post_likes (post_id, user_id)
values (pg_temp.uid('p_hidden'), pg_temp.uid('liker'));

select is(
  pg_temp.n_post_like(pg_temp.uid('poster'), pg_temp.uid('p_hidden')), 0,
  'liking a hidden post notifies nobody'
);

-- ---------------------------------------------------------------------------
-- 8. `follows` carries no content_status, so social_21 leaves tg_notify_follow
--    alone. Asserted so a future edit cannot break it unnoticed.
-- ---------------------------------------------------------------------------
insert into public.follows (follower_id, followee_id)
values (pg_temp.uid('follower'), pg_temp.uid('poster'));

select is(
  pg_temp.n_follow(pg_temp.uid('poster'), pg_temp.uid('follower')), 1,
  'follow notifications are untouched by social_21'
);

select * from finish();
rollback;
