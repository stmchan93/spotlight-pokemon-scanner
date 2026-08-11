-- Social layer — part 24: let a DM carry a PROFILE REFERENCE, so "share my
-- wishlist" or "share my collection" arrives as a tappable preview card rather
-- than a URL typed into the message body.
--
-- NOT YET APPLIED anywhere. Apply AFTER social_22 (it edits the same
-- `messages_have_content` constraint that migration installs).
--
-- Numbered 24, not 23: another session landed `social_23_post_reposts` on the
-- SAME `20260817090000` version prefix. Two files sharing a version is not a
-- cosmetic clash — the CLI keys applied state by that number, so it reported one
-- as applied and one as pending with no way to say which. Renamed to a unique,
-- later version rather than pushing into that ambiguity.
--
-- ===========================================================================
-- WHY A REFERENCE, AGAIN
-- ===========================================================================
-- Same argument social_22 makes for posts, and it survives the move to profiles:
--
--   A HYDRATED REFERENCE RESPECTS BLOCKS AT READ TIME. BAKED TEXT DOES NOT.
--
-- The preview is a separate read of that user's PUBLIC profile, so if the owner
-- later blocks the recipient — or the collection stops being visible to them —
-- the card simply stops resolving. A `spotlight://u/<id>` string baked into a
-- body is a permanent, unrevokable pointer sitting in a private thread that
-- nobody moderates, and it keeps working long after the relationship that
-- justified it is gone.
--
-- The text form is NOT removed: `share-post-sheet` still sends plain-text links,
-- which is what keeps sharing working against a project behind on migrations.
-- This is the richer path, not the only one.
--
-- ===========================================================================
-- WHAT IS STORED, AND WHAT IS DELIBERATELY NOT
-- ===========================================================================
-- The owner's user id and WHICH PAGE was shared. Nothing else — no card ids, no
-- snapshot of the list, no counts. A wishlist is a live thing; freezing four
-- card images into the message would make the preview a lie the moment the owner
-- pulls a card off the list, and would leak the contents of a list that later
-- became private.
--
-- `shared_profile_tab` is constrained to the tabs a public profile actually
-- serves. An unknown tab is rejected at write time rather than silently opening
-- the profile's default page, because a link that lands somewhere other than
-- where the sender pointed is worse than one that refuses to send.

-- ---------------------------------------------------------------------------
-- May this sender reference this profile at all?
-- ---------------------------------------------------------------------------
-- Mirrors `can_reference_post` (social_22). The insert policy constrains WHO
-- writes, never WHAT they reference, so without this a client could attach any
-- user id it liked — including someone who has blocked them, which would hand
-- the recipient a row asserting a relationship that is not allowed to exist.
create or replace function public.can_reference_profile(p_profile uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_profile is not null
    and p_user is not null
    -- The profile must exist as a real, visible profile...
    and exists (select 1 from public.user_profiles up where up.user_id = p_profile)
    -- ...and must not be on either side of a block with the sender. Sharing your
    -- OWN profile is the common case and is always allowed.
    and (p_profile = p_user or not public.is_blocked(p_profile, p_user));
$$;

revoke all on function public.can_reference_profile(uuid, uuid) from public;
grant execute on function public.can_reference_profile(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------
-- FK to the `public.users` MIRROR, never `auth.users` — social_10's rule, and the
-- reason is that ~18 FKs into GoTrue's proprietary schema are the most expensive
-- thing to unwind if we ever leave Supabase. `on delete set null` because this is
-- nullable attribution: deleting the owner must not raise inside the delete
-- trigger, which would break account deletion (including the backend's admin-API
-- path). The message survives with a dead reference and renders as unavailable,
-- which is exactly what a deleted owner should look like.
alter table public.messages
  add column if not exists shared_profile_user_id uuid references public.users(id) on delete set null;

alter table public.messages
  add column if not exists shared_profile_tab text;

-- Both or neither. A user id with no tab has no destination, and a tab with no
-- user id has no subject; either half alone renders as a broken card.
alter table public.messages
  drop constraint if exists messages_shared_profile_complete;
alter table public.messages
  add constraint messages_shared_profile_complete
  check (
    (shared_profile_user_id is null and shared_profile_tab is null)
    or (shared_profile_user_id is not null and shared_profile_tab is not null)
  );

alter table public.messages
  drop constraint if exists messages_shared_profile_tab_known;
alter table public.messages
  add constraint messages_shared_profile_tab_known
  check (shared_profile_tab is null or shared_profile_tab in ('collection', 'wishlist'));

-- An attachment-only share counts as content. Extends social_22's constraint
-- rather than replacing it — a message may now be carried by a body, a shared
-- post, OR a shared profile.
alter table public.messages
  drop constraint if exists messages_have_content;
alter table public.messages
  add constraint messages_have_content
  check (
    length(btrim(body)) > 0
    or shared_post_id is not null
    or shared_profile_user_id is not null
  );

alter table public.messages
  drop constraint if exists messages_shared_profile_visible;
alter table public.messages
  add constraint messages_shared_profile_visible
  check (
    shared_profile_user_id is null
    or public.can_reference_profile(shared_profile_user_id, sender_id)
  );

comment on column public.messages.shared_profile_user_id is
  'Profile whose collection/wishlist was shared into this thread. The preview is hydrated from the public profile on every read, so blocks and visibility changes take effect without touching this row.';
comment on column public.messages.shared_profile_tab is
  'Which public profile page the share points at: collection | wishlist.';
