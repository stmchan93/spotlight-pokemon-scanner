-- Social layer — part 28: per-show feeds.
--
-- social_27 added `posts.event_id` for booth posts. Attendees can now tag a post
-- to a show too: `event_id` set, `booth_vendor_id` null. The booth guard already
-- lets that through (it returns early when `booth_vendor_id` is null), so this
-- only adds a shape check on `event_id` itself. Show ids are the backend's
-- slugs (`ontario-2026-08`); anything else is junk a raw PostgREST write could
-- otherwise park in a show's feed forever.
--
-- The show feed is a plain keyset read over `idx_posts_event` (social_27), the
-- same shape as every other feed read, so no RPC is needed.
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

-- NOT VALID: existing rows (all written through the booth flow) are not
-- rescanned; every new or updated row is checked.
alter table public.posts drop constraint if exists posts_event_id_shape;
alter table public.posts add constraint posts_event_id_shape check (
  event_id is null
  or (char_length(event_id) between 1 and 64 and event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$')
) not valid;

commit;
