-- Social layer — part 13: make blocking apply to DMs, and replace the inbox's
-- per-thread unread fan-out with one RPC.
--
-- ===========================================================================
-- WHY THE BLOCK PART IS NOT OPTIONAL
-- ===========================================================================
-- `is_blocked` is already woven through the RLS of every OTHER social surface:
-- posts / post_media / comments SELECT (social_01), and follows / post_likes
-- INSERT (social_00, social_01). Blocking someone genuinely removes their feed
-- content, mutually, server-side.
--
-- `messages` has NONE of it. social_02's policies gate on participation only:
--
--   messages_insert ... with check (sender_id = auth.uid()
--                                   and is_conversation_participant(conversation_id, auth.uid()))
--
-- So today a blocked user can still open a thread with you and still send. That
-- matters more here than anywhere else in the app, because DMs are DELIBERATELY
-- excluded from the AI moderation pass (see backend/social_moderation_worker.py
-- and the comment on messages.content_status: "cheap gate only; DMs are private,
-- no AI pass"). Blocking is the ONLY safety mechanism DMs have, and it was the
-- one surface it did not cover.
--
-- Chosen semantics: the thread goes SILENT, not invisible. Blocking stops new
-- messages arriving; it does NOT hide the history.
--
-- The reason is reporting. `reports` (social_04) is polymorphic over
-- `target_type = 'message'`, and its threshold trigger hides a target once three
-- distinct people report it. Someone who blocks a harasser has to still be able
-- to open the thread and report what was said — which means both the message
-- rows and the conversation they hang off must stay readable to them. Hiding the
-- thread on block would destroy the evidence trail at exactly the moment it
-- matters, and would let a harasser erase their own history from the victim's
-- device by blocking first.
--
-- So the block check lands on the WRITE paths only. Reads are deliberately left
-- alone.
--
-- ===========================================================================
-- WHY A HELPER RATHER THAN INLINING is_blocked
-- ===========================================================================
-- The check is "does ANY other participant of this conversation have a block
-- with me, in either direction" — that needs a read of conversation_participants
-- from inside a policy ON conversation_participants. Inlining it re-creates the
-- exact RLS recursion trap that `is_conversation_participant` was introduced to
-- break in social_02. Same fix, same reason: a SECURITY DEFINER helper reads the
-- table without re-entering its own policy.
--
-- STABLE (not VOLATILE) so the planner may cache it per statement, matching
-- is_conversation_participant and is_blocked. `set search_path` because a
-- definer function without a pinned path can be hijacked via a temp-schema
-- shadow of any object it names.

begin;

-- ---------------------------------------------------------------------------
-- Helper: is this conversation blocked for `p_user`?
-- ---------------------------------------------------------------------------
create or replace function public.conversation_has_block(p_conversation uuid, p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  return exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation
      and cp.user_id <> p_user
      and public.is_blocked(p_user, cp.user_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply it to every DM read/write path
-- ---------------------------------------------------------------------------
-- Only the WRITE policies change. `conversations_select`, `messages_select`, and
-- `conv_participants_select` are deliberately NOT touched — see the reporting
-- rationale above. Blocking makes a thread read-only, not invisible.

-- THE protection: a blocked user cannot send. This is the only line that
-- actually stops harassment reaching an inbox; everything else is bookkeeping.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id, auth.uid())
    and not public.conversation_has_block(conversation_id, auth.uid())
  );

-- Blocks the "block them, then re-add them to a fresh thread" path.
drop policy if exists conv_participants_insert on public.conversation_participants;
create policy conv_participants_insert on public.conversation_participants for insert to authenticated
  with check (
    (
      user_id = auth.uid()
      or public.is_conversation_participant(conversation_id, auth.uid())
    )
    and not public.is_blocked(auth.uid(), user_id)
  );

-- ---------------------------------------------------------------------------
-- Unread counts: one RPC instead of N round trips
-- ---------------------------------------------------------------------------
-- The inbox previously issued one count-only query PER THREAD, because PostgREST
-- cannot express a grouped count without an RPC and this schema shipped none.
-- At the default page size that is up to 50 requests to draw one screen.
--
-- Returns a row per conversation with at least one unread message; threads with
-- nothing unread are omitted rather than returned as zero, so the payload stays
-- proportional to what actually needs a badge. The client treats a missing
-- conversation as zero.
--
-- Unread = newer than my last_read_at AND not sent by me. A null last_read_at
-- (never opened) means everything from the other person counts, which is why the
-- comparison is coalesced rather than dropped.
--
-- SECURITY DEFINER with the caller pinned to auth.uid() INTERNALLY — the
-- function takes no user argument, so it cannot be pointed at anyone else's
-- inbox.
--
-- Blocked threads are excluded from the COUNT even though they stay readable.
-- No new message can arrive once a block is in place, so any unread there is
-- frozen at whatever was outstanding at the moment of the block — a badge that
-- can never be cleared by the other person and nags forever about someone you
-- explicitly muted. The thread is still there to open and report; it just stops
-- demanding attention.
create or replace function public.unread_dm_counts()
returns table (conversation_id uuid, unread_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    return;
  end if;

  return query
  select m.conversation_id, count(*)::bigint
  from public.messages m
  join public.conversation_participants cp
    on cp.conversation_id = m.conversation_id
   and cp.user_id = me
  where m.sender_id <> me
    and m.deleted_at is null
    and m.created_at > coalesce(cp.last_read_at, '-infinity'::timestamptz)
    and not public.conversation_has_block(m.conversation_id, me)
  group by m.conversation_id;
end;
$$;

-- PostgREST only exposes what a role may execute. `authenticated` needs it;
-- `anon` deliberately does not — an unauthenticated caller gets auth.uid() null
-- and an empty set anyway, but not granting it keeps the surface honest.
revoke all on function public.unread_dm_counts() from public;
grant execute on function public.unread_dm_counts() to authenticated;

revoke all on function public.conversation_has_block(uuid, uuid) from public;
grant execute on function public.conversation_has_block(uuid, uuid) to authenticated;

-- Serves the RPC's per-conversation scan and the thread's newest-first read.
create index if not exists idx_messages_conv_sender_created
  on public.messages (conversation_id, sender_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Inbox previews: denormalize the last message onto the conversation
-- ---------------------------------------------------------------------------
-- Without this the inbox has to issue one `fetch newest message` request PER
-- THREAD just to render a one-line preview — the same N+1 the unread RPC above
-- exists to kill, reintroduced on a different column. `last_message_at` is
-- already denormalized here and kept fresh by `tg_messages_touch_conversation`
-- (social_02), so the preview rides along in that same trigger for free: no new
-- trigger, no second write path, and it cannot drift from the timestamp it is
-- displayed next to.
--
-- Truncated to 200 chars because it is rendered on ONE line with an ellipsis —
-- storing a 5,000-character message here would move the whole thing over the
-- wire for every inbox row to draw about forty visible characters.
alter table public.conversations
  add column if not exists last_message_preview text;

create or replace function public.tg_messages_touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.conversations
     set last_message_at = new.created_at,
         -- Only 'visible' text becomes a preview. A message the moderation
         -- prefilter marked 'removed' must not leak its body into the inbox,
         -- where it would render outside the thread that hides it.
         last_message_preview = case
           when new.content_status = 'visible' then left(new.body, 200)
           else null
         end
   where id = new.conversation_id;
  return null;
end;
$$;

-- Backfill so existing threads show a preview immediately rather than staying
-- blank until their next message. `distinct on` takes the newest row per
-- conversation; harmless on an empty table.
update public.conversations c
   set last_message_preview = left(m.body, 200)
  from (
    select distinct on (conversation_id) conversation_id, body
    from public.messages
    where deleted_at is null and content_status = 'visible'
    order by conversation_id, created_at desc
  ) m
 where m.conversation_id = c.id
   and c.last_message_preview is null;

commit;
