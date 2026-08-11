-- pgTAP — `posts.comment_count` must track VISIBILITY, not just deletion.
--
-- Covers task area 1 for comments. These are the regression tests for the bug
-- fixed by 20260814090000_social_20_moderation_aware_engagement_counters.sql:
-- before it, a comment whose body tripped a hard term inserted as
-- content_status='removed' and STILL bumped posts.comment_count, so a second
-- account saw "1 comment" on a thread that rendered empty.
--
-- The rule social_20 states once, in `public.is_counted_content()`:
--     counted  <=>  deleted_at is null AND content_status = 'visible'
--
-- The last two cases are the social_17 behaviour social_20 had to preserve:
-- an author soft-delete still decrements, and a hard DELETE of a row that was
-- already not counted must not decrement a second time.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;
set local search_path to public, extensions, pg_temp;
create extension if not exists pgtap;

select plan(11);

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

-- Reads the counter under test.
create function pg_temp.comment_count() returns integer
language sql stable as $fn$
  select comment_count from public.posts where id = pg_temp.uid('post')
$fn$;

-- `perform` inside a DO block rather than a bare `select`: pg_prove pipes psql
-- output straight into the TAP parser, so a fixture call must emit no rows.
do $do$ begin
  perform pg_temp.mk_user('poster');
  perform pg_temp.mk_user('commenter');
end $do$;

insert into public.posts (id, author_id, body)
values (pg_temp.newid('post'), pg_temp.uid('poster'), 'a perfectly ordinary charizard pull');

select is(pg_temp.comment_count(), 0, 'a fresh post starts at comment_count = 0');

-- ---------------------------------------------------------------------------
-- A visible comment counts
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_ok'), pg_temp.uid('post'), pg_temp.uid('commenter'), 'nice pull, congrats');

select is(pg_temp.comment_count(), 1, 'an ordinary comment increments comment_count');

-- ---------------------------------------------------------------------------
-- REGRESSION (social_20): a HARD-blocked comment must not count
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_hard'), pg_temp.uid('post'), pg_temp.uid('commenter'), 'zzblockedtest');

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_hard')),
  'removed',
  'guard: the HARD-term comment really did insert as removed'
);

select is(
  pg_temp.comment_count(), 1,
  'REGRESSION: a comment auto-removed by the prefilter does NOT increment comment_count'
);

-- ---------------------------------------------------------------------------
-- REGRESSION (social_20): a SOFT-blocked ('pending') comment must not count
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_soft'), pg_temp.uid('post'), pg_temp.uid('commenter'), 'zzsofttest');

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_soft')),
  'pending',
  'guard: the SOFT-term comment really did insert as pending'
);

select is(
  pg_temp.comment_count(), 1,
  'REGRESSION: a pending comment does NOT increment comment_count'
);

-- ---------------------------------------------------------------------------
-- pending -> visible (what the AI pass does when it clears a row) increments.
-- Only content_status is in the SET list, so the BEFORE UPDATE OF body
-- prefilter does not re-fire on the still-dirty body.
-- ---------------------------------------------------------------------------
update public.comments set content_status = 'visible' where id = pg_temp.uid('c_soft');

select is(
  pg_temp.comment_count(), 2,
  'pending -> visible (AI pass clearing a row) INCREMENTS comment_count'
);

-- ---------------------------------------------------------------------------
-- visible -> removed (AI pass confirming, or a moderator) decrements
-- ---------------------------------------------------------------------------
update public.comments set content_status = 'removed' where id = pg_temp.uid('c_ok');

select is(
  pg_temp.comment_count(), 1,
  'visible -> removed DECREMENTS comment_count'
);

-- ---------------------------------------------------------------------------
-- social_17 must still hold: an author soft-delete decrements
-- ---------------------------------------------------------------------------
update public.comments set deleted_at = now() where id = pg_temp.uid('c_soft');

select is(
  pg_temp.comment_count(), 0,
  'author soft-delete (deleted_at) still DECREMENTS comment_count (social_17)'
);

-- ---------------------------------------------------------------------------
-- social_17 must still hold: hard-deleting an already-uncounted row must not
-- decrement a second time. c_hard has been 'removed' since insert.
-- ---------------------------------------------------------------------------
delete from public.comments where id = pg_temp.uid('c_hard');

select is(
  pg_temp.comment_count(), 0,
  'hard DELETE of an already-hidden comment does not double-decrement'
);

-- ---------------------------------------------------------------------------
-- Restore (deleted_at back to null on a visible row) re-increments
-- ---------------------------------------------------------------------------
update public.comments set deleted_at = null where id = pg_temp.uid('c_soft');

select is(
  pg_temp.comment_count(), 1,
  'undeleting a visible comment re-INCREMENTS comment_count'
);

select * from finish();
rollback;
