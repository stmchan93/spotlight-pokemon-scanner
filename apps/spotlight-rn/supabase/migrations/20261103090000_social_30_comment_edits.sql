-- social_30: authors can edit their own comments.
--
-- The write path already exists: `comments_update` (social_01) lets the author
-- UPDATE their row, and `content_prefilter` (social_04/18) already fires on
-- `update of body`, so a hard-term edit is removed and a soft-term edit goes
-- pending exactly like an insert. What is missing:
--
--   1. `edited_at`, so the thread can say a comment was changed after people
--      may have replied to or liked it.
--   2. Re-moderation. The AI worker only scans rows where
--      `moderation_checked_at is null`. Without resetting it, a comment could
--      pass review clean and then be edited into something the worker never
--      sees. Clearing it on a body change queues the new text for another pass.
--      The worker never promotes `removed`, so editing a removed comment cannot
--      bring it back.
--   3. No editing a tombstone. A soft-deleted comment's body is redacted into
--      `deleted_content_bodies` (social_17); writing a new body would put words
--      back on a row the thread shows as deleted.
--
-- Trigger ORDER matters: BEFORE triggers on one table fire alphabetically, so
-- `comments_mark_edited` runs before `content_prefilter`. A hard-term edit is
-- therefore cleared here and then re-stamped checked + removed by the
-- prefilter, which is the same end state as a hard-term insert.
--
-- `update of body` binds to the statement's column list, so the social_17
-- redaction/restore triggers (which assign `new.body` during a deleted_at
-- transition) never fire this one.

begin;

alter table public.comments add column if not exists edited_at timestamptz;

create or replace function public.tg_comments_mark_edited()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.deleted_at is not null or new.deleted_at is not null then
    raise exception 'comment_deleted: a deleted comment cannot be edited';
  end if;
  new.edited_at := now();
  new.moderation_checked_at := null;
  return new;
end;
$$;

drop trigger if exists comments_mark_edited on public.comments;
create trigger comments_mark_edited
  before update of body on public.comments
  for each row
  when (old.body is distinct from new.body)
  execute function public.tg_comments_mark_edited();

-- `authenticated` holds table-level UPDATE on comments (social_17 §9), which
-- covers a new column; re-issued so this file does not depend on that.
grant update on public.comments to authenticated;

commit;

-- Verification (run as an author in the SQL editor with a JWT, or via the app):
--   update public.comments set body = 'edited' where id = '<own comment>';
--   select body, edited_at, moderation_checked_at from public.comments where id = '<own comment>';
--   -> edited_at set, moderation_checked_at null
--   update public.comments set body = 'x' where id = '<own soft-deleted comment>';
--   -> ERROR comment_deleted
