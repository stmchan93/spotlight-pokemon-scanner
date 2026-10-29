-- Social layer — part 27: booth posts (docs/booth-posts-vendor-spec-2026-10-29.md).
--
-- A vendor on a show's floor map (backend `spotlight_event_maps/<eventId>.json`,
-- keyed by a stable vendor slug) can be CLAIMED by one account, instantly, no
-- verification. The claimer can tag posts to their booth, and reads private
-- booth stats. Attendees' card opens / Instagram taps / message taps / post
-- views are logged as booth_events; "N browsing" comes from event_presence.
--
-- Claims are keyed by vendor slug, not per show, so a claim carries to the
-- next show that lists the same vendor. `event_id` records where it was made.
--
-- Writes to booth_events / event_presence / booth_claims go through security
-- definer RPCs only (no direct insert policies), so dedupe, rate limits and the
-- "one active claim per booth" rule can't be skipped by a raw PostgREST write.
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------
create table if not exists public.booth_claims (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   text not null,
  event_id    text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  claimed_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users(id) on delete set null
);
create unique index if not exists uq_booth_claims_active on public.booth_claims (vendor_id)
  where revoked_at is null;
create index if not exists idx_booth_claims_user on public.booth_claims (user_id)
  where revoked_at is null;

alter table public.booth_claims enable row level security;

-- Who holds a booth is public (the card shows their @handle).
drop policy if exists booth_claims_select on public.booth_claims;
create policy booth_claims_select on public.booth_claims for select to authenticated
  using (revoked_at is null or user_id = auth.uid() or public.is_admin());

create table if not exists public.booth_reports (
  vendor_id   text not null,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (vendor_id, reporter_id)
);
alter table public.booth_reports enable row level security;

drop policy if exists booth_reports_insert on public.booth_reports;
create policy booth_reports_insert on public.booth_reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists booth_reports_select on public.booth_reports;
create policy booth_reports_select on public.booth_reports for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

-- The active claimer of a vendor, or null.
create or replace function public.booth_claimer(p_vendor_id text)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select user_id from public.booth_claims where vendor_id = p_vendor_id and revoked_at is null limit 1;
$$;

-- Returns 'claimed' | 'already_yours' | 'taken' | 'limit' | 'unauthenticated'.
-- 'limit': one account may hold at most 3 booths (multi-name vendors are rare).
create or replace function public.claim_booth(p_vendor_id text, p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  holder uuid;
begin
  if me is null then
    return 'unauthenticated';
  end if;
  holder := public.booth_claimer(p_vendor_id);
  if holder = me then
    return 'already_yours';
  elsif holder is not null then
    return 'taken';
  end if;
  if (select count(*) from public.booth_claims where user_id = me and revoked_at is null) >= 3 then
    return 'limit';
  end if;
  begin
    insert into public.booth_claims (vendor_id, event_id, user_id) values (p_vendor_id, p_event_id, me);
  exception when unique_violation then
    return 'taken';
  end;
  return 'claimed';
end;
$$;

-- The holder can let go; an admin can unclaim anyone.
create or replace function public.unclaim_booth(p_vendor_id text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  update public.booth_claims
     set revoked_at = now(), revoked_by = auth.uid()
   where vendor_id = p_vendor_id
     and revoked_at is null
     and (user_id = auth.uid() or public.is_admin());
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Booth-tagged posts
-- ---------------------------------------------------------------------------
alter table public.posts add column if not exists event_id text;
alter table public.posts add column if not exists booth_vendor_id text;
create index if not exists idx_posts_event on public.posts (event_id, created_at desc)
  where event_id is not null and deleted_at is null;

-- Only the active claimer may tag a post to a booth, and a booth tag needs a show.
create or replace function public.tg_posts_booth_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.booth_vendor_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.booth_vendor_id is not distinct from old.booth_vendor_id then
    return new;
  end if;
  if new.event_id is null then
    raise exception 'booth post needs an event_id';
  end if;
  if public.booth_claimer(new.booth_vendor_id) is distinct from new.author_id then
    raise exception 'only the booth''s claimer can post to it';
  end if;
  return new;
end;
$$;
drop trigger if exists posts_booth_guard on public.posts;
create trigger posts_booth_guard before insert or update of booth_vendor_id, event_id on public.posts
  for each row execute function public.tg_posts_booth_guard();

-- ---------------------------------------------------------------------------
-- Booth events (private stats)
-- ---------------------------------------------------------------------------
create table if not exists public.booth_events (
  id         bigint generated always as identity primary key,
  event_id   text not null,
  vendor_id  text not null,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('card_open', 'instagram_tap', 'message_start', 'post_view')),
  created_at timestamptz not null default now()
);
create index if not exists idx_booth_events_vendor on public.booth_events (vendor_id, event_id, kind, created_at);
create index if not exists idx_booth_events_dedupe on public.booth_events (viewer_id, vendor_id, kind, created_at desc);

-- No policies: nobody reads or writes the table directly.
alter table public.booth_events enable row level security;

-- Same viewer + booth + kind counts once per 10 minutes; the claimer's own
-- opens don't count. Returns whether a row was written.
create or replace function public.record_booth_event(p_event_id text, p_vendor_id text, p_kind text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
begin
  if me is null or p_kind not in ('card_open', 'instagram_tap', 'message_start', 'post_view') then
    return false;
  end if;
  if public.booth_claimer(p_vendor_id) = me then
    return false;
  end if;
  if exists (
    select 1 from public.booth_events
     where viewer_id = me and vendor_id = p_vendor_id and kind = p_kind
       and created_at > now() - interval '10 minutes'
  ) then
    return false;
  end if;
  insert into public.booth_events (event_id, vendor_id, viewer_id, kind)
  values (p_event_id, p_vendor_id, me, p_kind);
  return true;
end;
$$;

-- Counts for one booth at one show (all shows when p_event_id is null), plus a
-- last-24h slice ("today" without knowing the show's timezone). Claimer or
-- admin only.
create or replace function public.booth_stats(p_vendor_id text, p_event_id text default null)
returns table (kind text, total bigint, viewers bigint, last_24h bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public.booth_claimer(p_vendor_id) is distinct from auth.uid() and not public.is_admin() then
    return;
  end if;
  return query
    select e.kind,
           count(*)::bigint,
           count(distinct e.viewer_id)::bigint,
           count(*) filter (where e.created_at > now() - interval '24 hours')::bigint
      from public.booth_events e
     where e.vendor_id = p_vendor_id
       and (p_event_id is null or e.event_id = p_event_id)
     group by e.kind;
end;
$$;

-- ---------------------------------------------------------------------------
-- Presence ("N people browsing the map")
-- ---------------------------------------------------------------------------
create table if not exists public.event_presence (
  event_id  text not null,
  user_id   uuid not null references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists idx_event_presence_recent on public.event_presence (event_id, last_seen desc);
alter table public.event_presence enable row level security;

create or replace function public.touch_event_presence(p_event_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or coalesce(p_event_id, '') = '' then
    return;
  end if;
  insert into public.event_presence (event_id, user_id, last_seen)
  values (p_event_id, auth.uid(), now())
  on conflict (event_id, user_id) do update set last_seen = excluded.last_seen;
end;
$$;

-- Distinct people on this show's page or map in the last 15 minutes.
create or replace function public.event_browsing_now(p_event_id text)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.event_presence
   where event_id = p_event_id and last_seen > now() - interval '15 minutes';
$$;

-- ---------------------------------------------------------------------------
-- Admin overview + post-show recap
-- ---------------------------------------------------------------------------
-- One row per active claim with the holder's handle, report count and totals.
create or replace function public.booth_admin_overview(p_event_id text default null)
returns table (
  vendor_id text, event_id text, user_id uuid, handle text, claimed_at timestamptz,
  report_count bigint, card_opens bigint, instagram_taps bigint, message_starts bigint,
  post_views bigint, post_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    return;
  end if;
  return query
    select c.vendor_id, c.event_id, c.user_id, up.handle, c.claimed_at,
           (select count(*) from public.booth_reports r where r.vendor_id = c.vendor_id),
           (select count(*) from public.booth_events e where e.vendor_id = c.vendor_id and e.kind = 'card_open' and (p_event_id is null or e.event_id = p_event_id)),
           (select count(*) from public.booth_events e where e.vendor_id = c.vendor_id and e.kind = 'instagram_tap' and (p_event_id is null or e.event_id = p_event_id)),
           (select count(*) from public.booth_events e where e.vendor_id = c.vendor_id and e.kind = 'message_start' and (p_event_id is null or e.event_id = p_event_id)),
           (select count(*) from public.booth_events e where e.vendor_id = c.vendor_id and e.kind = 'post_view' and (p_event_id is null or e.event_id = p_event_id)),
           (select count(*) from public.posts p where p.booth_vendor_id = c.vendor_id and p.deleted_at is null and (p_event_id is null or p.event_id = p_event_id))
      from public.booth_claims c
      left join public.user_profiles up on up.user_id = c.user_id
     where c.revoked_at is null
     order by c.claimed_at;
end;
$$;

-- Recap notifications carry their numbers in `payload`.
alter table public.notifications add column if not exists payload jsonb;

-- One 'booth_recap' notification per active claimer whose booth had any
-- activity at this show. Idempotent per (recipient, event). Service role / admin
-- only; the backend runs it the day after a show ends.
create or replace function public.send_booth_recaps(p_event_id text, p_event_name text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer := 0;
  c record;
  s jsonb;
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    return 0;
  end if;
  for c in select vendor_id, user_id from public.booth_claims where revoked_at is null loop
    select jsonb_object_agg(kind, cnt) into s
      from (select kind, count(*) as cnt from public.booth_events
             where vendor_id = c.vendor_id and event_id = p_event_id group by kind) t;
    if s is null then
      continue;
    end if;
    if exists (select 1 from public.notifications
                where recipient_id = c.user_id and type = 'booth_recap'
                  and payload->>'event_id' = p_event_id and payload->>'vendor_id' = c.vendor_id) then
      continue;
    end if;
    insert into public.notifications (recipient_id, type, payload)
    values (c.user_id, 'booth_recap', jsonb_build_object(
      'event_id', p_event_id, 'event_name', p_event_name, 'vendor_id', c.vendor_id, 'counts', s));
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.claim_booth(text, text) from public, anon;
revoke all on function public.unclaim_booth(text) from public, anon;
revoke all on function public.record_booth_event(text, text, text) from public, anon;
revoke all on function public.booth_stats(text, text) from public, anon;
revoke all on function public.touch_event_presence(text) from public, anon;
revoke all on function public.event_browsing_now(text) from public, anon;
revoke all on function public.booth_admin_overview(text) from public, anon;
revoke all on function public.send_booth_recaps(text, text) from public, anon, authenticated;
grant execute on function public.claim_booth(text, text) to authenticated;
grant execute on function public.unclaim_booth(text) to authenticated;
grant execute on function public.record_booth_event(text, text, text) to authenticated;
grant execute on function public.booth_stats(text, text) to authenticated;
grant execute on function public.touch_event_presence(text) to authenticated;
grant execute on function public.event_browsing_now(text) to authenticated;
grant execute on function public.booth_admin_overview(text) to authenticated, service_role;
grant execute on function public.send_booth_recaps(text, text) to service_role;
grant execute on function public.booth_claimer(text) to authenticated;

commit;
