-- Social layer — part 33: show post types.
--
-- A post tagged to a show (`event_id`, social_27/28) can say what it is for:
--   looking_for — an attendee wants to buy
--   selling     — a vendor/table has it
--   buying      — a vendor buylist ("paying 70% on vintage holos")
-- Optional: untyped show posts stay allowed. Untagged posts never carry one.
--
-- The show feed filters on it server-side (`.eq('post_intent', …)`), keyset
-- paged on created_at, so the index leads with (event_id, post_intent).
--
-- RLS: `posts_insert` / `posts_update` (social_01) check only author_id, and
-- `posts` carries table-level grants (social_17), so the new column is
-- writable by the author with no policy change.
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

alter table public.posts add column if not exists post_intent text;

-- Every existing row has a null post_intent, so validating costs one scan.
alter table public.posts drop constraint if exists posts_post_intent_check;
alter table public.posts add constraint posts_post_intent_check check (
  post_intent is null
  or (post_intent in ('looking_for', 'selling', 'buying') and event_id is not null)
);

create index if not exists idx_posts_event_intent
  on public.posts (event_id, post_intent, created_at desc)
  where event_id is not null and post_intent is not null and deleted_at is null;

commit;
