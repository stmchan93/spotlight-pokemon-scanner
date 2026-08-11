-- pgTAP — `user_profiles.post_count` must track VISIBILITY, not just deletion.
--
-- Covers task area 1 for posts. Same regression as
-- 020_counter_posts_comment_count_test.sql, on the other counter social_20
-- names in its blast radius: before the fix a hard-blocked post still
-- incremented its author's PUBLIC post count, so a profile advertised posts no
-- reader could open.
--
--     counted  <=>  deleted_at is null AND content_status = 'visible'
--                   (public.is_counted_content)
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

create function pg_temp.post_count() returns integer
language sql stable as $fn$
  select post_count from public.user_profiles where user_id = pg_temp.uid('poster')
$fn$;

-- `perform` inside a DO block rather than a bare `select`: pg_prove pipes psql
-- output straight into the TAP parser, so a fixture call must emit no rows.
do $do$ begin
  perform pg_temp.mk_user('poster');
end $do$;

select is(pg_temp.post_count(), 0, 'a fresh profile starts at post_count = 0');

-- ---------------------------------------------------------------------------
-- A visible post counts
-- ---------------------------------------------------------------------------
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_ok'), pg_temp.uid('poster'), 'a perfectly ordinary charizard pull');

select is(pg_temp.post_count(), 1, 'an ordinary post increments post_count');

-- ---------------------------------------------------------------------------
-- REGRESSION (social_20): a HARD-blocked post must not count
-- ---------------------------------------------------------------------------
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_hard'), pg_temp.uid('poster'), 'zzblockedtest');

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_hard')),
  'removed',
  'guard: the HARD-term post really did insert as removed'
);

select is(
  pg_temp.post_count(), 1,
  'REGRESSION: a post auto-removed by the prefilter does NOT increment post_count'
);

-- ---------------------------------------------------------------------------
-- REGRESSION (social_20): a SOFT-blocked ('pending') post must not count
-- ---------------------------------------------------------------------------
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_soft'), pg_temp.uid('poster'), 'zzsofttest');

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_soft')),
  'pending',
  'guard: the SOFT-term post really did insert as pending'
);

select is(
  pg_temp.post_count(), 1,
  'REGRESSION: a pending post does NOT increment post_count'
);

-- ---------------------------------------------------------------------------
-- pending -> visible increments (the AI pass releasing a clean row)
-- ---------------------------------------------------------------------------
update public.posts set content_status = 'visible' where id = pg_temp.uid('p_soft');

select is(
  pg_temp.post_count(), 2,
  'pending -> visible (AI pass clearing a row) INCREMENTS post_count'
);

-- ---------------------------------------------------------------------------
-- visible -> removed decrements
-- ---------------------------------------------------------------------------
update public.posts set content_status = 'removed' where id = pg_temp.uid('p_ok');

select is(
  pg_temp.post_count(), 1,
  'visible -> removed DECREMENTS post_count'
);

-- ---------------------------------------------------------------------------
-- social_17 must still hold: an author soft-delete decrements
-- ---------------------------------------------------------------------------
update public.posts set deleted_at = now() where id = pg_temp.uid('p_soft');

select is(
  pg_temp.post_count(), 0,
  'author soft-delete (deleted_at) still DECREMENTS post_count (social_17)'
);

-- ---------------------------------------------------------------------------
-- social_17 must still hold: no double-decrement on hard DELETE of a row that
-- was already not counted.
-- ---------------------------------------------------------------------------
delete from public.posts where id = pg_temp.uid('p_hard');

select is(
  pg_temp.post_count(), 0,
  'hard DELETE of an already-hidden post does not double-decrement'
);

-- ---------------------------------------------------------------------------
-- Restore re-increments
-- ---------------------------------------------------------------------------
update public.posts set deleted_at = null where id = pg_temp.uid('p_soft');

select is(
  pg_temp.post_count(), 1,
  'undeleting a visible post re-INCREMENTS post_count'
);

select * from finish();
rollback;
