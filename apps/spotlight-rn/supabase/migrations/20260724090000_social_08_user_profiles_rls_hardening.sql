-- Social layer — part 08: tighten user_profiles RLS.
--
-- Promotes the reviewed policy from manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql
-- into a tracked migration, now that it's been consciously approved and verified
-- against a live authenticated (guest) token. See
-- docs/portfolio-social-phase-2-public-profiles-follow-2026-07-23.md ("The RLS
-- problem") for why each piece is shaped this way.
--
-- Net effect: user_profiles becomes SELF-ONLY for reads and writes, with the
-- sensitive columns fenced off by column privileges (not a subquery). Cross-user
-- profile reads already go through the public_profiles view (social_07). Closes
-- the live hole where any authenticated user could self-set admin_enabled with the
-- bundled anon key.
--
-- SAFE: additive/idempotent-ish. The DO-block drops whatever policies exist by
-- name, so it does not depend on the legacy dashboard policy names. Transactional —
-- if anything errors, the whole thing rolls back and current behavior is preserved.

begin;

alter table public.user_profiles enable row level security;

-- Drop EVERY existing policy (legacy dashboard names + any earlier revision), so a
-- stray permissive policy can't OR away the restrictions below.
do $$
declare
  existing record;
begin
  for existing in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'user_profiles'
  loop
    execute format('drop policy if exists %I on public.user_profiles', existing.policyname);
  end loop;
end;
$$;

-- Read: self only. Cross-user reads use public.public_profiles (moderation-filtered,
-- sensitive columns absent). auth.uid() wrapped as a subselect → InitPlan, not
-- per-row.
create policy user_profiles_self_read on public.user_profiles for select to authenticated
  using (user_id = (select auth.uid()));

-- Write ownership: the row must be your own on both insert and update. The COLUMNS
-- you may write are fenced by the grants below, not by a policy subquery (no
-- recursion hazard, no NULL semantics, can't be OR'd away).
create policy user_profiles_self_insert on public.user_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy user_profiles_self_update on public.user_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Column privileges for BOTH insert and update. Fencing insert too closes the
-- new-row escalation the earlier draft missed: without this, a brand-new user could
-- INSERT their own row with admin_enabled=true (the insert policy only checks row
-- ownership). status / is_shadowbanned / admin_enabled / labeler_enabled /
-- is_verified / reputation / the counters are all writable ONLY by triggers
-- (SECURITY DEFINER) or service_role from here on.
revoke insert, update on public.user_profiles from authenticated;
grant insert (user_id, display_name, avatar_url, handle, bio, location, social_link)
  on public.user_profiles to authenticated;
grant update (user_id, display_name, avatar_url, handle, bio, location, social_link)
  on public.user_profiles to authenticated;

-- No DELETE policy (nothing client-side deletes profiles; cascade + service_role
-- bypass RLS). No `anon` policy (guests carry the authenticated role).

-- Admin moderation: kept for intent, but NOT sufficient alone — the revoke above
-- strips column UPDATE from `authenticated`, and admins share that role, so status/
-- shadowban/admin_enabled writes must go through a SECURITY DEFINER RPC or
-- service_role (which has BYPASSRLS). That RPC is future moderation-UI work.
create policy user_profiles_admin_update on public.user_profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;
