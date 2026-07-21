-- Social layer — part 04: moderation. Synchronous in-DB pre-filter (wordlist +
-- rate limit), community reports, report-threshold auto-hide, and the admin audit
-- trail. The async AI pass (OpenAI omni-moderation on the VM) lives in
-- backend/social_moderation_worker.py and updates rows this file leaves pending.
--
-- No Edge Functions. All-new tables. Full RLS.

begin;

-- ---------------------------------------------------------------------------
-- Moderation tables
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_terms (
  term     text primary key,          -- stored lowercase
  severity text not null default 'hard'  -- hard = auto-remove, soft = send to pending
);

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null,          -- post | comment | message | profile
  target_id   uuid not null,
  reason      text,
  status      text not null default 'open',   -- open | actioned | dismissed
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)   -- one open report per user per target
);
create index if not exists idx_reports_target on public.reports (target_type, target_id) where status = 'open';

create table if not exists public.moderation_actions (
  id           uuid primary key default gen_random_uuid(),
  moderator_id uuid references auth.users(id) on delete set null,
  target_type  text not null,
  target_id    uuid not null,
  action       text not null,         -- hide | remove | approve | suspend_user | ban_user | shadowban
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_moderation_actions_target on public.moderation_actions (target_type, target_id);

-- ---------------------------------------------------------------------------
-- Synchronous pre-filter: wordlist + rate limit. BEFORE INSERT/UPDATE on
-- posts / comments / messages. SECURITY DEFINER so it can read blocked_terms
-- regardless of that table's RLS.
-- ---------------------------------------------------------------------------
create or replace function public.tg_content_prefilter()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_body       text := lower(coalesce(new.body, ''));
  v_author     uuid;
  v_author_col text := case when tg_table_name = 'messages' then 'sender_id' else 'author_id' end;
  v_recent     integer;
  v_hit        text;
  c_rate_limit constant integer := 30;   -- max rows per author per minute (per table)
begin
  -- Author id without knowing the column name at compile time (posts/comments use
  -- author_id, messages uses sender_id).
  v_author := (to_jsonb(new) ->> v_author_col)::uuid;

  -- Rate limit (only meaningful on INSERT).
  if tg_op = 'INSERT' then
    execute format(
      'select count(*) from public.%I where %I = $1 and created_at > now() - interval ''1 minute''',
      tg_table_name, v_author_col
    ) into v_recent using v_author;
    if v_recent >= c_rate_limit then
      raise exception 'rate_limited: too many posts in a short time, slow down';
    end if;
  end if;

  -- Hard slurs -> removed immediately, and mark as AI-checked (no need to re-scan).
  select term into v_hit from public.blocked_terms
   where severity = 'hard' and v_body like '%' || term || '%' limit 1;
  if v_hit is not null then
    new.content_status := 'removed';
    if tg_table_name <> 'messages' then
      new.moderation_checked_at := now();
    end if;
    return new;
  end if;

  -- Soft terms -> pending; leave moderation_checked_at null so the AI pass decides.
  select term into v_hit from public.blocked_terms
   where severity = 'soft' and v_body like '%' || term || '%' limit 1;
  if v_hit is not null then
    new.content_status := 'pending';
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists content_prefilter on public.posts;
create trigger content_prefilter before insert or update of body on public.posts
  for each row execute function public.tg_content_prefilter();

drop trigger if exists content_prefilter on public.comments;
create trigger content_prefilter before insert or update of body on public.comments
  for each row execute function public.tg_content_prefilter();

drop trigger if exists content_prefilter on public.messages;
create trigger content_prefilter before insert on public.messages
  for each row execute function public.tg_content_prefilter();

-- ---------------------------------------------------------------------------
-- Community reports -> auto-hide once K distinct reporters flag one target.
-- SECURITY DEFINER so it can update the target regardless of the reporter's RLS.
-- ---------------------------------------------------------------------------
create or replace function public.tg_reports_threshold()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_count       integer;
  c_threshold   constant integer := 3;   -- distinct reporters to auto-hide
begin
  select count(distinct reporter_id) into v_count
    from public.reports
   where target_type = new.target_type and target_id = new.target_id and status = 'open';

  if v_count >= c_threshold then
    if new.target_type = 'post' then
      update public.posts set content_status = 'pending'
        where id = new.target_id and content_status = 'visible';
    elsif new.target_type = 'comment' then
      update public.comments set content_status = 'pending'
        where id = new.target_id and content_status = 'visible';
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists reports_threshold on public.reports;
create trigger reports_threshold after insert on public.reports
  for each row execute function public.tg_reports_threshold();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.blocked_terms      enable row level security;
alter table public.reports            enable row level security;
alter table public.moderation_actions enable row level security;

-- blocked_terms: admins only for direct access (the prefilter reads it via SECURITY DEFINER).
drop policy if exists blocked_terms_admin on public.blocked_terms;
create policy blocked_terms_admin on public.blocked_terms for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- reports: any authed user files a report as themselves; only admins read/triage.
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists reports_admin_select on public.reports;
create policy reports_admin_select on public.reports for select to authenticated
  using (public.is_admin());
drop policy if exists reports_admin_update on public.reports;
create policy reports_admin_update on public.reports for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- moderation_actions: admins only.
drop policy if exists moderation_actions_admin on public.moderation_actions;
create policy moderation_actions_admin on public.moderation_actions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;
