-- Social layer — part 03: notifications (drives in-app badges; delivered via Realtime).
-- Rows are written by the app/worker (service role) or future triggers; the recipient
-- reads/updates only their own. All-new table. Full RLS.

begin;

create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  recipient_id    uuid not null references auth.users(id) on delete cascade,
  actor_id        uuid references auth.users(id) on delete set null,
  type            text not null,                 -- like | comment | follow | mention | message
  post_id         uuid references public.posts(id) on delete cascade,
  comment_id      uuid references public.comments(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_notifications_recipient on public.notifications (recipient_id, created_at desc);
create index if not exists idx_notifications_unread on public.notifications (recipient_id)
  where read_at is null;

alter table public.notifications enable row level security;

-- recipient reads their own; can mark read (update); cannot forge notifications for others.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
-- No client INSERT policy: notifications are created server-side (service role bypasses RLS)
-- or by future SECURITY DEFINER triggers, never forged directly by clients.

commit;
