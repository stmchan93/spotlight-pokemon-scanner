-- Social layer — part 22: let a DM carry a POST REFERENCE, so "share this post"
-- means sending it to someone rather than republishing it.
--
-- NOT YET APPLIED anywhere. Apply to staging first, then production.
--
-- ===========================================================================
-- WHY A REFERENCE AND NOT A LINK IN THE BODY
-- ===========================================================================
-- The cheap version of this feature is to put a `spotlight://post/<id>` string
-- in `messages.body` and parse it on the client. That is wrong, and the reason
-- is moderation:
--
--   A HYDRATED REFERENCE RESPECTS MODERATION AT READ TIME. BAKED TEXT DOES NOT.
--
-- The preview is a separate SELECT against `posts`, so `posts_select` (social_01,
-- tightened by social_19) answers "may this reader see this post?" on EVERY
-- read. If the post is later removed by the moderation worker, soft-deleted by
-- its author, or its author blocks the recipient, the preview simply stops
-- resolving. Nothing here has to know about any of that.
--
-- A link baked into a body is a permanent copy of something that was supposed to
-- disappear, sitting in a private thread that nobody moderates. That is the
-- failure mode a repost would have had, arriving through the back door.
--
-- ===========================================================================
-- WHAT THIS DOES NOT NEED
-- ===========================================================================
-- No RLS change. `messages_insert` (social_13) already constrains the sender and
-- their participation:
--
--   with check (
--     sender_id = auth.uid()
--     and public.is_conversation_participant(conversation_id, auth.uid())
--     and not public.conversation_has_block(conversation_id, auth.uid())
--   )
--
-- and `messages_select` gates reads on participation. Neither cares about a new
-- nullable column.
--
-- What that policy does NOT do is constrain column CONTENT — so without the
-- check below, a client could attach any post id it liked, including one it is
-- not allowed to see, and hand the recipient a row that leaks a post's existence
-- (and, if the recipient CAN see it, its content). Hence `can_reference_post`.

-- ---------------------------------------------------------------------------
-- May this user attach this post?
-- ---------------------------------------------------------------------------
-- Deliberately mirrors `posts_select` rather than inventing a second rule: if
-- you cannot read the post, you cannot send it. SECURITY DEFINER because the
-- check runs inside an INSERT on `messages`, where the caller's own read of
-- `posts` would otherwise recurse through RLS.
--
-- STABLE, not IMMUTABLE: it reads tables, and its answer changes when a post is
-- removed or a block is created.
create or replace function public.can_reference_post(p_post uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.posts p
     where p.id = p_post
       and p.deleted_at is null
       and (
         p.author_id = p_user
         or (p.content_status = 'visible' and not public.is_blocked(p_user, p.author_id))
       )
  );
$$;

revoke all on function public.can_reference_post(uuid, uuid) from public;
grant execute on function public.can_reference_post(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL, not CASCADE: a hard-deleted post must not take the
-- CONVERSATION's message with it. The message stays, the reference empties, and
-- the client renders its "no longer available" state — which it needs anyway for
-- the removed/blocked cases, where the row still exists but does not resolve.
alter table public.messages
  add column if not exists shared_post_id uuid references public.posts(id) on delete set null;

-- Partial: the overwhelming majority of messages are plain text.
create index if not exists idx_messages_shared_post
  on public.messages (shared_post_id)
  where shared_post_id is not null;

-- A message must SAY something: text, a shared post, or both. Without this an
-- empty body with no attachment is insertable, which renders as a blank bubble.
--
-- `body` stays `not null` — an attachment-only share sends '' rather than null,
-- so nothing downstream has to handle a null body.
alter table public.messages
  drop constraint if exists messages_have_content;
alter table public.messages
  add constraint messages_have_content
  check (length(btrim(body)) > 0 or shared_post_id is not null);

-- You may only attach a post you can see. See the note above: the insert policy
-- constrains WHO may write, not WHAT they may reference.
alter table public.messages
  drop constraint if exists messages_shared_post_visible;
alter table public.messages
  add constraint messages_shared_post_visible
  check (shared_post_id is null or public.can_reference_post(shared_post_id, sender_id));

comment on column public.messages.shared_post_id is
  'Post shared into this thread. The preview is hydrated from posts on every read, so removal, soft-delete and blocks all take effect without touching this row.';
