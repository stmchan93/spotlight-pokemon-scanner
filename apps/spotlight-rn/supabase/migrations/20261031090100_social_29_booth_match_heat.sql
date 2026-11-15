-- Social layer — part 29: "This is you" booth matching + live booth heat
-- (docs/booth-posts-vendor-spec-2026-10-29.md).
--
-- booth_vendor_emails holds sha256(lower(trim(email))) of each vendor's Treasure
-- application email, never the email itself. It is loaded from the builder's
-- private sidecar by tools/sync_vendor_email_hashes.py with the service role.
-- Nobody else reads it: RLS on with no policies, and suggest_my_booth only
-- compares against the CALLER's own JWT email, returning vendor ids.
--
-- event_hot_booths names booths with recent card opens from several distinct
-- people. It never returns counts; exact numbers stay in booth_stats (claimer only).
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Vendor email hashes
-- ---------------------------------------------------------------------------
create table if not exists public.booth_vendor_emails (
  event_id     text not null,
  vendor_id    text not null,
  email_sha256 text not null check (email_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (event_id, vendor_id, email_sha256)
);
create index if not exists idx_booth_vendor_emails_hash on public.booth_vendor_emails (event_id, email_sha256);

-- No policies: only security definer functions and the service role touch it.
alter table public.booth_vendor_emails enable row level security;
revoke all on table public.booth_vendor_emails from public, anon, authenticated;
grant select, insert, delete on table public.booth_vendor_emails to service_role;

-- Vendor ids at this show whose Treasure email is the caller's own sign-in email.
-- digest() is unqualified: pgcrypto lives in `extensions` on Supabase, `public` on some older projects.
create or replace function public.suggest_my_booth(p_event_id text)
returns setof text language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select e.vendor_id
    from public.booth_vendor_emails e
   where e.event_id = p_event_id
     and coalesce(trim(auth.jwt()->>'email'), '') <> ''
     and e.email_sha256 = encode(digest(lower(trim(auth.jwt()->>'email')), 'sha256'), 'hex')
   order by e.vendor_id;
$$;

-- Replaces one show's hashes in one transaction. p_hashes = {"vendor-id": ["<sha256 hex>", ...]}.
-- Service role only. Returns the number of rows written.
create or replace function public.replace_booth_vendor_emails(p_event_id text, p_hashes jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role only';
  end if;
  if coalesce(p_event_id, '') = '' or jsonb_typeof(p_hashes) is distinct from 'object' then
    raise exception 'need an event id and a {vendor: [hashes]} object';
  end if;
  delete from public.booth_vendor_emails where event_id = p_event_id;
  insert into public.booth_vendor_emails (event_id, vendor_id, email_sha256)
  select distinct p_event_id, v.key, h.value
    from jsonb_each(p_hashes) v
   cross join lateral jsonb_array_elements_text(case when jsonb_typeof(v.value) = 'array' then v.value else '[]'::jsonb end) h;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live heat
-- ---------------------------------------------------------------------------
create index if not exists idx_booth_events_event_recent on public.booth_events (event_id, kind, created_at);

-- Up to 10 vendor ids whose card was opened by >= 3 distinct people in the last
-- 30 minutes, hottest first. Ids only: the threshold keeps one person's taps
-- from being inferable, and counts stay private.
create or replace function public.event_hot_booths(p_event_id text)
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select e.vendor_id
    from public.booth_events e
   where e.event_id = p_event_id
     and e.kind = 'card_open'
     and e.created_at > now() - interval '30 minutes'
   group by e.vendor_id
  having count(distinct e.viewer_id) >= 3
   order by count(distinct e.viewer_id) desc, max(e.created_at) desc, e.vendor_id
   limit 10;
$$;

revoke all on function public.suggest_my_booth(text) from public, anon;
revoke all on function public.replace_booth_vendor_emails(text, jsonb) from public, anon, authenticated;
revoke all on function public.event_hot_booths(text) from public, anon;
grant execute on function public.suggest_my_booth(text) to authenticated;
grant execute on function public.replace_booth_vendor_emails(text, jsonb) to service_role;
grant execute on function public.event_hot_booths(text) to authenticated;

commit;
