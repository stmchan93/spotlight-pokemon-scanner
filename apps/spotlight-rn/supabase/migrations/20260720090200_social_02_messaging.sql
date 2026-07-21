-- Social layer — part 02: direct messaging (conversations, participants, messages).
-- All-new tables. Full RLS. Realtime-ready (subscribe to messages under RLS).

begin;

create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  is_group        boolean not null default false,
  dm_key          text unique,                    -- sorted "uidA:uidB" to dedupe 1:1 DMs (null for groups)
  last_message_at timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  last_read_at    timestamptz,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists idx_conv_participants_user on public.conversation_participants (user_id);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references auth.users(id) on delete cascade,
  body            text not null,
  content_status  text not null default 'visible',   -- cheap gate only; DMs are private, no AI pass
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists idx_messages_conv_created on public.messages (conversation_id, created_at desc);

-- Membership helper (breaks the messages<->participants RLS recursion trap).
create or replace function public.is_conversation_participant(p_conversation uuid, p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.conversation_participants
    where conversation_id = p_conversation and user_id = p_user
  );
end;
$$;

-- Keep conversations.last_message_at fresh for inbox sorting.
create or replace function public.tg_messages_touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return null;
end;
$$;
drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.tg_messages_touch_conversation();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.conversations              enable row level security;
alter table public.conversation_participants  enable row level security;
alter table public.messages                   enable row level security;

-- conversations: only participants can see; any authed user can create one.
drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (public.is_conversation_participant(id, auth.uid()));
drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations for insert to authenticated
  with check (created_by = auth.uid());

-- participants: you can see rows of conversations you're in; you can add yourself, or
-- add others to a conversation you already belong to (1:1 DM setup, group invites).
drop policy if exists conv_participants_select on public.conversation_participants;
create policy conv_participants_select on public.conversation_participants for select to authenticated
  using (public.is_conversation_participant(conversation_id, auth.uid()));
drop policy if exists conv_participants_insert on public.conversation_participants;
create policy conv_participants_insert on public.conversation_participants for insert to authenticated
  with check (
    user_id = auth.uid()
    or public.is_conversation_participant(conversation_id, auth.uid())
  );
-- update only your own row (e.g. last_read_at); leave a conversation by deleting your row.
drop policy if exists conv_participants_update on public.conversation_participants;
create policy conv_participants_update on public.conversation_participants for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists conv_participants_delete on public.conversation_participants;
create policy conv_participants_delete on public.conversation_participants for delete to authenticated
  using (user_id = auth.uid());

-- messages: only participants read; only participants send as themselves.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (deleted_at is null and public.is_conversation_participant(conversation_id, auth.uid()));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_conversation_participant(conversation_id, auth.uid()));
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (sender_id = auth.uid()) with check (sender_id = auth.uid());

commit;
