-- Social layer — part 07: the public profile read surface, and the counter-trigger
-- fix that has to land BEFORE user_profiles RLS is tightened.
--
-- SAFETY: additive + idempotent. Creates one view and re-creates two existing
-- trigger functions with identical bodies plus `security definer`. No policy
-- changes, no column changes, no data changes. Safe to push on its own — and it
-- MUST be pushed before ../manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql.
--
-- Context: docs/portfolio-social-phase-2-public-profiles-follow-2026-07-23.md

begin;

-- ---------------------------------------------------------------------------
-- Declare the one column the repo was missing
-- ---------------------------------------------------------------------------
-- `labeler_enabled` exists in the live database (added via the Supabase dashboard)
-- and is read by auth-service.ts, but appeared in no SQL file here — so the repo
-- could not tell you the real shape of this table. Declaring it makes the
-- migrations the source of truth and removes a manual pre-flight step.
-- Idempotent: a no-op where the column already exists.
alter table public.user_profiles add column if not exists labeler_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Public profile read surface
-- ---------------------------------------------------------------------------
-- Phase 2 needs to read OTHER users' profiles. It must NOT do that by making
-- user_profiles world-readable: RLS filters rows, never columns, so a blanket
-- `using (true)` select policy would also publish `status`, `is_shadowbanned`,
-- `admin_enabled`, and `labeler_enabled` to every client. Two of those are
-- actively harmful — a shadowban that the shadowbanned user can query is not a
-- shadowban, and `admin_enabled` is the complete moderator roster.
--
-- Sharper than it first looks: guests authenticate via signInAnonymously()
-- (auth-service.ts), so they hold the `authenticated` role too. `to authenticated`
-- means anyone with the anon key that ships inside the app bundle — i.e. anyone.
--
-- So: user_profiles stays self-read-only, and cross-user reads come through this
-- curated view, which exposes only the columns a profile page renders.
--
-- security_invoker = false (the default, stated explicitly because it is the whole
-- point): the view runs as its owner, so it can read past user_profiles' row
-- policies. That is what lets the moderation filter below be enforced here rather
-- than trusted to the client.
create or replace view public.public_profiles
  with (security_invoker = false) as
  select
    user_id,
    display_name,
    avatar_url,
    handle,
    bio,
    location,
    social_link,
    is_verified,
    reputation,
    follower_count,
    following_count,
    post_count,
    created_at
  from public.user_profiles
  -- Suspended, banned, and shadowbanned users simply have no public profile.
  -- The client sees an ordinary "not found" and is never told which it was.
  where status = 'active'
    and not is_shadowbanned;

grant select on public.public_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Counter triggers: make them SECURITY DEFINER before RLS tightens
-- ---------------------------------------------------------------------------
-- These update a profile row that is NOT the acting user's:
--   * tg_follows_counts bumps follower_count on the FOLLOWEE's row
--   * tg_posts_author_count will fail column-level grants once those land
--
-- Trigger functions run as the invoking user. The moment user_profiles carries a
-- self-only UPDATE policy, `where user_id = <the other person>` matches zero rows
-- — and RLS filters UPDATE rows SILENTLY rather than raising. The follow would
-- succeed, following_count would increment, follower_count would not, and nothing
-- anywhere would error. Counts would drift permanently and asymmetrically.
--
-- Bodies below are byte-identical to social_00 / social_01; only the
-- `security definer set search_path` qualifiers are new.
create or replace function public.tg_follows_counts()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    update public.user_profiles set follower_count  = follower_count  + 1 where user_id = new.followee_id;
    update public.user_profiles set following_count = following_count + 1 where user_id = new.follower_id;
  elsif tg_op = 'DELETE' then
    update public.user_profiles set follower_count  = greatest(follower_count  - 1, 0) where user_id = old.followee_id;
    update public.user_profiles set following_count = greatest(following_count - 1, 0) where user_id = old.follower_id;
  end if;
  return null;
end;
$$;

create or replace function public.tg_posts_author_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    update public.user_profiles set post_count = post_count + 1 where user_id = new.author_id;
  elsif tg_op = 'DELETE' then
    update public.user_profiles set post_count = greatest(post_count - 1, 0) where user_id = old.author_id;
  end if;
  return null;
end;
$$;

commit;
