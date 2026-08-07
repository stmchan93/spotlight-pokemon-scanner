-- Social layer — part 14: give every real signup a profile row.
--
-- ===========================================================================
-- THE BUG
-- ===========================================================================
-- `user_profiles` rows were created by exactly ONE code path: the upsert inside
-- `updateProfile()` (auth-service.ts), which runs when someone edits their
-- profile. Nothing created a row at signup.
--
-- `public_profiles` is a view over `user_profiles`, and it is what people-search,
-- follow, and the DM "Message" action all read. So a user who signed up and never
-- opened Edit Profile had no row, was in no view, and was therefore invisible:
-- unsearchable, unfollowable, unmessageable. They could use the app and simply
-- not exist to anyone else.
--
-- Observed on staging before this migration: 4 rows in auth.users, 1 in
-- user_profiles. Three of four accounts were socially invisible. This was not a
-- DM bug — DMs are just what made it visible; follow and profiles had been broken
-- the same way since social_00.
--
-- ===========================================================================
-- ANONYMOUS SESSIONS NEVER GET A PROFILE
-- ===========================================================================
-- `auth.users.is_anonymous` is the gate, and it is a hard rule, not a default.
-- Guest/anonymous sessions are throwaway identities: giving them profile rows
-- would fill people-search with nameless ghosts nobody can act on, and inflate
-- every follower/discovery surface with accounts that will never be claimed.
--
-- A guest who later converts to a real account keeps the SAME auth.users row and
-- flips `is_anonymous` to false — an UPDATE, not an INSERT. So the insert trigger
-- alone would miss every conversion. That is why there is a second trigger below
-- on the anonymous→real transition; without it, converting a guest would leave
-- them in exactly the invisible state this migration exists to fix.
--
-- ===========================================================================
-- WHY A TRIGGER RATHER THAN CLIENT CODE
-- ===========================================================================
-- The client already had its chance — `updateProfile()` is client-side and only
-- fires if the user visits a screen. A row that must exist for EVERY user has to
-- be created where the user is created, in the same transaction, or it is
-- conditional on the user happening to visit the right screen.
--
-- social_10 already establishes that `create trigger ... on auth.users` works on
-- this project (see its PRIVILEGES note) — same pattern, same owner requirement.
--
-- Additive and idempotent: no column changes, `on conflict do nothing` throughout,
-- and the backfill only touches rows that are missing.

begin;

-- ---------------------------------------------------------------------------
-- Seed helper
-- ---------------------------------------------------------------------------
-- Display name comes from the signup metadata the client already writes
-- (`syncUserMetadata` in auth-service.ts sets display_name), falling back to the
-- local-part of the email so a profile is never nameless — a blank row in search
-- is barely better than no row at all.
--
-- `handle` is left NULL on purpose. It is optional in this product, there is no
-- longer a UI to set one, and auto-generating handles from emails would leak the
-- local-part of an address into a public surface.
create or replace function public.seed_user_profile(p_user auth.users)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  seeded_name text;
begin
  -- Hard gate. Anonymous identities must never appear in a public surface.
  if coalesce(p_user.is_anonymous, false) then
    return;
  end if;

  seeded_name := nullif(trim(coalesce(
    p_user.raw_user_meta_data ->> 'display_name',
    p_user.raw_user_meta_data ->> 'full_name',
    p_user.raw_user_meta_data ->> 'name',
    split_part(coalesce(p_user.email, ''), '@', 1)
  )), '');

  insert into public.user_profiles (user_id, display_name)
  values (p_user.id, seeded_name)
  on conflict (user_id) do nothing;   -- never clobber a profile the user has edited
end;
$$;

-- ---------------------------------------------------------------------------
-- New signups
-- ---------------------------------------------------------------------------
create or replace function public.tg_auth_user_seed_profile()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform public.seed_user_profile(new);
  return null;
end;
$$;

drop trigger if exists auth_users_seed_profile_insert on auth.users;
create trigger auth_users_seed_profile_insert
  after insert on auth.users
  for each row execute function public.tg_auth_user_seed_profile();

-- ---------------------------------------------------------------------------
-- Guest → real conversions
-- ---------------------------------------------------------------------------
-- Converting keeps the same row and flips is_anonymous to false, so it is an
-- UPDATE the insert trigger never sees. Fires only on the false-ward transition,
-- so ordinary profile updates (email change, metadata sync, last_sign_in_at)
-- don't re-run the seed on every write.
create or replace function public.tg_auth_user_converted_seed_profile()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(old.is_anonymous, false) and not coalesce(new.is_anonymous, false) then
    perform public.seed_user_profile(new);
  end if;
  return null;
end;
$$;

drop trigger if exists auth_users_seed_profile_convert on auth.users;
create trigger auth_users_seed_profile_convert
  after update of is_anonymous on auth.users
  for each row execute function public.tg_auth_user_converted_seed_profile();

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Every real account that predates the trigger. Without this the fix only helps
-- people who sign up from now on, and the users already stranded stay invisible.
-- Anonymous rows are excluded by the same rule the trigger enforces.
insert into public.user_profiles (user_id, display_name)
select
  u.id,
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'display_name',
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name',
    split_part(coalesce(u.email, ''), '@', 1)
  )), '')
from auth.users u
where not coalesce(u.is_anonymous, false)
on conflict (user_id) do nothing;

commit;
