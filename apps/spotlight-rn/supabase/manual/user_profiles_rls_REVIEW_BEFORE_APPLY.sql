-- ============================================================================
-- REVIEW BEFORE APPLYING — this touches the LIVE user_profiles (auth) table.
-- ============================================================================
-- It is deliberately NOT in migrations/ so `supabase db push` does NOT run it.
-- Apply it consciously only after confirming it matches your current dashboard
-- policies, ideally on a preview branch / dev project first.
--
-- Why it's needed: the social layer needs profiles to be PUBLICLY readable (to
-- render authors/handles). Today user_profiles RLS lives only in the Supabase
-- dashboard. This makes it explicit + version-controlled.
--
-- What it does: enables RLS on user_profiles (if not already) and installs
-- policies that PRESERVE current behavior (each user reads/writes their own row)
-- and ADD public read + admin moderation writes. If your app currently relies on
-- RLS being DISABLED, enabling it with only these policies could change behavior —
-- verify the self read/insert/update policies cover every flow in auth-service.ts
-- before running.
-- ============================================================================

begin;

alter table public.user_profiles enable row level security;

-- Public read: anyone signed in can view any profile (public-by-default model).
drop policy if exists user_profiles_public_read on public.user_profiles;
create policy user_profiles_public_read on public.user_profiles for select to authenticated
  using (true);

-- Self insert (profile onboarding / upsert).
drop policy if exists user_profiles_self_insert on public.user_profiles;
create policy user_profiles_self_insert on public.user_profiles for insert to authenticated
  with check (user_id = auth.uid());

-- Self update — but NOT the moderation-controlled columns (status / shadowban /
-- admin flag), which only admins may change.
drop policy if exists user_profiles_self_update on public.user_profiles;
create policy user_profiles_self_update on public.user_profiles for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and status = (select status from public.user_profiles p where p.user_id = auth.uid())
    and is_shadowbanned = (select is_shadowbanned from public.user_profiles p where p.user_id = auth.uid())
    and admin_enabled = (select admin_enabled from public.user_profiles p where p.user_id = auth.uid())
  );

-- Admin: moderators can update any profile (suspend / ban / shadowban).
drop policy if exists user_profiles_admin_update on public.user_profiles;
create policy user_profiles_admin_update on public.user_profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;
