-- Social layer — part 00: extensions, identity (user_profiles extension), helper
-- functions, and the social graph (follows / blocks / mutes).
--
-- SAFETY: additive only. New tables + additive columns on user_profiles. This file
-- does NOT enable RLS on user_profiles (that is isolated in
-- ../manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql because it touches the live
-- auth table). All NEW social tables get full RLS here.

begin;

create extension if not exists citext;
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Identity: extend the EXISTING user_profiles table (additive columns only)
-- ---------------------------------------------------------------------------
alter table public.user_profiles add column if not exists handle          citext;
alter table public.user_profiles add column if not exists bio             text;
alter table public.user_profiles add column if not exists status          text    not null default 'active';   -- active | suspended | banned
alter table public.user_profiles add column if not exists is_shadowbanned boolean not null default false;
alter table public.user_profiles add column if not exists follower_count  integer not null default 0;
alter table public.user_profiles add column if not exists following_count integer not null default 0;
alter table public.user_profiles add column if not exists post_count      integer not null default 0;
alter table public.user_profiles add column if not exists admin_enabled   boolean not null default false;   -- ensure present (moderation hook)
alter table public.user_profiles add column if not exists created_at      timestamptz not null default now();
alter table public.user_profiles add column if not exists updated_at      timestamptz not null default now();

-- @handle is unique when set; multiple NULLs allowed until users claim handles.
create unique index if not exists uq_user_profiles_handle
  on public.user_profiles (handle) where handle is not null;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.user_profiles;
create trigger set_updated_at before update on public.user_profiles
  for each row execute function public.tg_set_updated_at();

-- is_admin(): reads the caller's admin flag. SECURITY DEFINER so RLS on
-- user_profiles never hides the flag from the check.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select admin_enabled from public.user_profiles where user_id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- Social graph
-- ---------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists idx_follows_followee on public.follows (followee_id);

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists idx_blocks_blocked on public.blocks (blocked_id);

create table if not exists public.mutes (
  muter_id uuid not null references auth.users(id) on delete cascade,
  muted_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (muter_id, muted_id),
  check (muter_id <> muted_id)
);

-- is_blocked(): either-direction block check. plpgsql so it is robust to object
-- creation order; SECURITY DEFINER so it works under RLS.
create or replace function public.is_blocked(a uuid, b uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
end;
$$;

-- Follower/following counters on user_profiles.
create or replace function public.tg_follows_counts()
returns trigger language plpgsql as $$
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
drop trigger if exists follows_counts on public.follows;
create trigger follows_counts after insert or delete on public.follows
  for each row execute function public.tg_follows_counts();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.follows enable row level security;
alter table public.blocks  enable row level security;
alter table public.mutes   enable row level security;

-- follows: public-readable graph; you manage only your own follow rows; can't follow someone who blocked you.
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select to authenticated using (true);
drop policy if exists follows_insert on public.follows;
create policy follows_insert on public.follows for insert to authenticated
  with check (follower_id = auth.uid() and not public.is_blocked(auth.uid(), followee_id));
drop policy if exists follows_delete on public.follows;
create policy follows_delete on public.follows for delete to authenticated
  using (follower_id = auth.uid());

-- blocks / mutes: strictly private to the acting user.
drop policy if exists blocks_all on public.blocks;
create policy blocks_all on public.blocks for all to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());
drop policy if exists mutes_all on public.mutes;
create policy mutes_all on public.mutes for all to authenticated
  using (muter_id = auth.uid()) with check (muter_id = auth.uid());

commit;
