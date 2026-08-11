-- pgTAP — moderation pre-filter tiers (`public.tg_content_prefilter`).
--
-- Covers task area 2: 'zzblockedtest' -> removed, 'zzsofttest' -> pending,
-- ordinary text -> visible, on BOTH posts and comments.
--
-- Where the two test terms come from (checked, not assumed):
--   * 'zzblockedtest' (hard) — seeded by
--     20260720090500_social_05_storage_and_seed.sql, and re-seeded by
--     20260812090000_social_18_moderation_wordlist_word_boundary.sql.
--   * 'zzsofttest'    (soft) — seeded by
--     20260814090000_social_20_moderation_aware_engagement_counters.sql.
--
-- The matcher under test is social_18's word-boundary version
-- (`v_body ~ ('\y' || regexp_escape_literal(term) || '\y')`), which social_19
-- and social_20 both leave alone.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;
set local search_path to public, extensions, pg_temp;
create extension if not exists pgtap;

select plan(14);

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
-- `user_profiles`, and the social_10 trigger mirrors the id into `public.users`;
-- the explicit upsert below is a belt-and-braces so a counter assertion can
-- never silently depend on profile seeding.
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

-- `perform` inside a DO block rather than a bare `select`: pg_prove pipes psql
-- output straight into the TAP parser, so a fixture call must emit no rows.
do $do$ begin
  perform pg_temp.mk_user('author');
end $do$;

-- ---------------------------------------------------------------------------
-- 1. The seeded wordlist is what the migrations say it is
-- ---------------------------------------------------------------------------
select is(
  (select severity from public.blocked_terms where term = 'zzblockedtest'),
  'hard',
  'social_05/social_18 seed zzblockedtest as the HARD test term'
);

select is(
  (select severity from public.blocked_terms where term = 'zzsofttest'),
  'soft',
  'social_20 seeds zzsofttest as the SOFT test term'
);

-- ---------------------------------------------------------------------------
-- 2. Posts: the three tiers
-- ---------------------------------------------------------------------------
-- One statement per row: `newid()` writes to pg_temp.ids, and a later row in the
-- same statement must never have to read what an earlier row wrote.
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_ok'), pg_temp.uid('author'), 'a perfectly ordinary charizard pull');
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_hard'), pg_temp.uid('author'), 'contains zzblockedtest inline');
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_soft'), pg_temp.uid('author'), 'contains zzsofttest inline');

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_ok')),
  'visible',
  'post with ordinary text inserts as visible'
);

select ok(
  (select moderation_checked_at is null from public.posts where id = pg_temp.uid('p_ok')),
  'ordinary post is left unchecked for the async AI pass'
);

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_hard')),
  'removed',
  'post tripping a HARD term inserts as removed'
);

select ok(
  (select moderation_checked_at is not null from public.posts where id = pg_temp.uid('p_hard')),
  'a HARD hit stamps moderation_checked_at (no AI re-scan needed)'
);

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_soft')),
  'pending',
  'post tripping a SOFT term inserts as pending'
);

select ok(
  (select moderation_checked_at is null from public.posts where id = pg_temp.uid('p_soft')),
  'a SOFT hit leaves moderation_checked_at null so the AI pass decides'
);

-- ---------------------------------------------------------------------------
-- 3. Comments: the same three tiers
-- ---------------------------------------------------------------------------
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_ok'), pg_temp.uid('p_ok'), pg_temp.uid('author'), 'nice pull, congrats');
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_hard'), pg_temp.uid('p_ok'), pg_temp.uid('author'), 'zzblockedtest');
insert into public.comments (id, post_id, author_id, body)
values (pg_temp.newid('c_soft'), pg_temp.uid('p_ok'), pg_temp.uid('author'), 'zzsofttest');

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_ok')),
  'visible',
  'comment with ordinary text inserts as visible'
);

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_hard')),
  'removed',
  'comment tripping a HARD term inserts as removed'
);

select is(
  (select content_status from public.comments where id = pg_temp.uid('c_soft')),
  'pending',
  'comment tripping a SOFT term inserts as pending'
);

-- ---------------------------------------------------------------------------
-- 4. Matching semantics social_18 pinned down
-- ---------------------------------------------------------------------------
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_boundary'), pg_temp.uid('author'), 'the word zzblockedtesting is not the term');
insert into public.posts (id, author_id, body)
values (pg_temp.newid('p_upper'), pg_temp.uid('author'), 'SHOUTING ZZBLOCKEDTEST LOUDLY');

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_boundary')),
  'visible',
  'word-boundary matching: a hard term inside a longer word does NOT trip (social_18)'
);

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_upper')),
  'removed',
  'matching is case-insensitive'
);

-- The trigger is BEFORE INSERT OR UPDATE OF body, so editing a clean post into a
-- dirty one must also be caught.
update public.posts set body = 'edited to contain zzblockedtest' where id = pg_temp.uid('p_ok');

select is(
  (select content_status from public.posts where id = pg_temp.uid('p_ok')),
  'removed',
  'editing a visible post body into a HARD term re-runs the prefilter and removes it'
);

select * from finish();
rollback;
