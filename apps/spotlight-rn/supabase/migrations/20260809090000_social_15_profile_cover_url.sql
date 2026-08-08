-- Social layer — part 15: profile COVER photo column.
--
-- NOT YET APPLIED anywhere. Apply to staging first, then production.
--
-- The Edit Profile screen's cover-photo badge picks and uploads a banner
-- (backend `POST /api/v1/profile/cover` → public GCS bucket, `covers/` prefix,
-- same owner-scoping as avatars). This is the one piece the client cannot
-- provide for itself: somewhere to persist the returned URL.
--
-- SAFETY: additive + idempotent. One nullable column, and a `create or replace`
-- of the read-only public view to expose it. No policy changes, no data
-- changes, no drops. The app tolerates this migration NOT being applied — its
-- profile reads fall back to a cover-less select — so there is no ordering
-- requirement against an app release.

begin;

-- Public URL of the profile banner. Nullable: most profiles have no cover, and
-- the header falls back to a flat gray band.
alter table public.user_profiles add column if not exists cover_url text;

-- Re-declare the curated public read surface with the new column. Body is
-- otherwise byte-identical to social_07 — same columns in the same order, same
-- security_invoker = false, same moderation filter. `cover_url` is
-- presentational, exactly like `avatar_url`, so it belongs on the public view;
-- moderation state and capability flags stay off it.
--
-- `cover_url` is APPENDED, not slotted in beside `avatar_url`: CREATE OR REPLACE
-- VIEW may only add columns at the END of the list — reordering or renaming an
-- existing one is rejected outright, and would otherwise force a drop/recreate
-- that also drops the grant.
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
    created_at,
    cover_url
  from public.user_profiles
  where status = 'active'
    and not is_shadowbanned;

grant select on public.public_profiles to authenticated;

commit;
