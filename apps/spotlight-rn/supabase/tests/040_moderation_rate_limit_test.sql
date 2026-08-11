-- pgTAP — the pre-filter's per-author-per-minute rate limit.
--
-- Covers task area 3. The constant lives in `public.tg_content_prefilter()`:
--
--     c_rate_limit constant integer := 30;   -- max rows per author per minute (per table)
--
-- declared in 20260720090400_social_04_moderation.sql and carried over verbatim
-- by 20260812090000_social_18_moderation_wordlist_word_boundary.sql. The check
-- is `>=`, evaluated BEFORE the row lands, so the 30th insert is accepted and
-- the 31st raises. It scopes on `tg_table_name` and the author column, so the
-- budget is per author AND per table.
--
-- The whole file runs in one transaction, so `now()` is frozen at transaction
-- start and every row is inside the same one-minute window by construction —
-- there is no wall-clock flakiness here.
--
-- Failures are captured as `SQLSTATE: message` strings rather than asserted
-- with throws_ok(), so the expected error text is visible in the diff on
-- failure and there is no pgTAP overload ambiguity around the errcode argument.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;
set local search_path to public, extensions, pg_temp;
create extension if not exists pgtap;

select plan(6);

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

-- Each of these returns 'ok', or 'SQLSTATE: message'. The exception handler is
-- an implicit savepoint, so a rejected insert leaves the transaction usable.
create function pg_temp.fill_posts(p_author uuid, p_n integer) returns text
language plpgsql as $fn$
declare i integer;
begin
  for i in 1..p_n loop
    insert into public.posts (author_id, body) values (p_author, 'benign rate limit filler');
  end loop;
  return 'ok';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$fn$;

create function pg_temp.try_post(p_author uuid) returns text
language plpgsql as $fn$
begin
  insert into public.posts (author_id, body) values (p_author, 'benign rate limit filler');
  return 'ok';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$fn$;

create function pg_temp.try_comment(p_author uuid, p_post uuid) returns text
language plpgsql as $fn$
begin
  insert into public.comments (post_id, author_id, body)
  values (p_post, p_author, 'benign rate limit filler');
  return 'ok';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$fn$;

-- `perform` inside a DO block rather than a bare `select`: pg_prove pipes psql
-- output straight into the TAP parser, so a fixture call must emit no rows.
do $do$ begin
  perform pg_temp.mk_user('spammer');
  perform pg_temp.mk_user('bystander');
end $do$;

-- Something for the spammer to comment on. One post, well under the bystander's
-- own budget.
insert into public.posts (id, author_id, body)
values (pg_temp.newid('anchor'), pg_temp.uid('bystander'), 'a perfectly ordinary charizard pull');

-- ---------------------------------------------------------------------------
-- The cap is 30 — the 30th is accepted
-- ---------------------------------------------------------------------------
select is(
  pg_temp.fill_posts(pg_temp.uid('spammer'), 30),
  'ok',
  '30 posts by one author inside one minute are all accepted (c_rate_limit = 30)'
);

select is(
  (select count(*)::integer from public.posts where author_id = pg_temp.uid('spammer')),
  30,
  'all 30 rows really landed'
);

-- ---------------------------------------------------------------------------
-- The 31st is rejected
-- ---------------------------------------------------------------------------
select is(
  pg_temp.try_post(pg_temp.uid('spammer')),
  'P0001: rate_limited: too many posts in a short time, slow down',
  'the 31st post in the same minute raises rate_limited'
);

select is(
  (select count(*)::integer from public.posts where author_id = pg_temp.uid('spammer')),
  30,
  'the rejected insert left no row behind'
);

-- ---------------------------------------------------------------------------
-- The budget is per author...
-- ---------------------------------------------------------------------------
select is(
  pg_temp.try_post(pg_temp.uid('bystander')),
  'ok',
  'the limit is per author: a different author is unaffected'
);

-- ---------------------------------------------------------------------------
-- ...and per table (the trigger scopes on tg_table_name)
-- ---------------------------------------------------------------------------
select is(
  pg_temp.try_comment(pg_temp.uid('spammer'), pg_temp.uid('anchor')),
  'ok',
  'the limit is per table: a post-capped author can still comment'
);

select * from finish();
rollback;
