-- pgTAP — community reports auto-hide a target at N distinct reporters.
--
-- Covers task area 4. The constant lives in `public.tg_reports_threshold()`:
--
--     c_threshold constant integer := 3;   -- distinct reporters to auto-hide
--
-- declared in 20260720090400_social_04_moderation.sql, untouched since. The
-- trigger is AFTER INSERT on `public.reports`; it counts DISTINCT reporter_id
-- over open reports for the target and flips a still-'visible' post/comment to
-- 'pending'.
--
-- "Distinct reporters" is enforced structurally as well: `reports` carries
-- `unique (reporter_id, target_type, target_id)`, so one user cannot stack
-- three reports onto one target. That is asserted here too, because it is what
-- makes the threshold mean three PEOPLE.
--
-- The auto-hide is also one of the three UPDATE paths social_20 exists to
-- catch, so the counter moves are asserted alongside the status flip.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;
set local search_path to public, extensions, pg_temp;
create extension if not exists pgtap;

select plan(10);

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

create function pg_temp.report(p_reporter text, p_type text, p_target uuid) returns text
language plpgsql as $fn$
begin
  insert into public.reports (reporter_id, target_type, target_id, reason)
  values (pg_temp.uid(p_reporter), p_type, p_target, 'test');
  return 'ok';
exception when others then
  return sqlstate;
end;
$fn$;

create function pg_temp.post_status() returns text
language sql stable as $fn$
  select content_status from public.posts where id = pg_temp.uid('post')
$fn$;

create function pg_temp.comment_status() returns text
language sql stable as $fn$
  select content_status from public.comments where id = pg_temp.uid('comment')
$fn$;

-- `perform` inside a DO block rather than a bare `select`: pg_prove pipes psql
-- output straight into the TAP parser, so a fixture call must emit no rows.
do $do$ begin
  perform pg_temp.mk_user('author');
  perform pg_temp.mk_user('reporter1');
  perform pg_temp.mk_user('reporter2');
  perform pg_temp.mk_user('reporter3');
end $do$;

insert into public.posts (id, author_id, body)
values (pg_temp.newid('post'), pg_temp.uid('author'), 'a perfectly ordinary charizard pull');

insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('comment'), pg_temp.uid('post'), pg_temp.uid('author'), 'nice pull, congrats');

select is(pg_temp.post_status(), 'visible', 'guard: the target post starts visible');

-- ---------------------------------------------------------------------------
-- N - 1 reporters do NOT hide the post
-- ---------------------------------------------------------------------------
do $do$ begin perform pg_temp.report('reporter1', 'post', pg_temp.uid('post')); end $do$;
select is(pg_temp.post_status(), 'visible', '1 reporter does not auto-hide a post');

do $do$ begin perform pg_temp.report('reporter2', 'post', pg_temp.uid('post')); end $do$;
select is(pg_temp.post_status(), 'visible', '2 reporters (threshold - 1) do not auto-hide a post');

-- ---------------------------------------------------------------------------
-- One reporter cannot stack their way to the threshold
-- ---------------------------------------------------------------------------
select is(
  pg_temp.report('reporter2', 'post', pg_temp.uid('post')),
  '23505',
  'a second report from the SAME reporter is rejected by the unique constraint'
);

select is(pg_temp.post_status(), 'visible', 'the duplicate report did not tip the threshold');

-- ---------------------------------------------------------------------------
-- The Nth distinct reporter hides it
-- ---------------------------------------------------------------------------
do $do$ begin perform pg_temp.report('reporter3', 'post', pg_temp.uid('post')); end $do$;
select is(pg_temp.post_status(), 'pending', '3 distinct reporters (c_threshold = 3) auto-hide a post');

-- social_20: the auto-hide UPDATE must also move the author's counter.
select is(
  (select post_count from public.user_profiles where user_id = pg_temp.uid('author')),
  0,
  'the report auto-hide DECREMENTS post_count (social_20 UPDATE path c)'
);

-- ---------------------------------------------------------------------------
-- Same threshold for comments
-- ---------------------------------------------------------------------------
select is(pg_temp.comment_status(), 'visible', 'guard: the target comment starts visible');

do $do$ begin
  perform pg_temp.report('reporter1', 'comment', pg_temp.uid('comment'));
  perform pg_temp.report('reporter2', 'comment', pg_temp.uid('comment'));
end $do$;
select is(pg_temp.comment_status(), 'visible', '2 reporters do not auto-hide a comment');

do $do$ begin perform pg_temp.report('reporter3', 'comment', pg_temp.uid('comment')); end $do$;
select is(pg_temp.comment_status(), 'pending', '3 distinct reporters auto-hide a comment');

select * from finish();
rollback;
