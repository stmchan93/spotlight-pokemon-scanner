-- Social layer — part 12: actually publish `messages` to Realtime.
--
-- social_02 shipped DMs and called them "Realtime-ready (subscribe to messages
-- under RLS)". That comment only ever described the RLS SHAPE — the table was
-- never added to the `supabase_realtime` publication, and no migration since has
-- mentioned it. Realtime reads its change stream from that publication, so a
-- client `.channel(...).on('postgres_changes', { table: 'messages' })` subscribes
-- successfully, reports SUBSCRIBED, and then receives NOTHING. Forever. There is
-- no error to notice: the socket is healthy, the channel is joined, the table
-- simply isn't in the stream. This migration is what makes DM realtime emit.
--
-- WHY `replica identity full`
--   The default replica identity (`default`) puts only the primary key in the
--   WAL for UPDATE/DELETE. Realtime builds its `old_record` payload from that, so
--   without this an update arrives carrying just `{ id }` — every other column
--   reads as absent. The DM surfaces that need old_record are exactly the ones
--   that would break: soft-delete (`deleted_at` set) and moderation
--   (`content_status` flipped) both arrive as UPDATEs, and a subscriber cannot
--   tell what changed from a payload with one field in it. INSERT is unaffected,
--   which is why a naive test ("send a message, it appears") would pass anyway
--   and hide this.
--
--   Cost: UPDATE/DELETE now WAL-log the entire old row. `messages` rows are a
--   uuid pair plus a short text body and are almost never updated, so this is
--   negligible here. It is NOT a blanket-safe setting for wide or hot tables.
--
-- RLS STILL APPLIES
--   Realtime evaluates the table's RLS SELECT policy per subscriber, so
--   `messages_select` (participants only, `deleted_at is null`) still gates every
--   broadcast row. Publishing the table does not widen who can read a DM.
--
-- IDEMPOTENCY IS LOAD-BEARING, NOT POLITENESS
--   `alter publication ... add table` ERRORS with "relation is already member of
--   publication" on a re-run — it has no `if not exists`. Left unguarded, this
--   file would fail the moment the chain replays over a database that already has
--   it, which is precisely the scenario
--   docs/supabase-project-split-and-promotion-2026-08-06.md exists to protect:
--   the whole chain must apply cleanly from zero against a fresh project. Hence
--   the pg_publication_tables probe below.
--
-- Additive and transactional. Creates no table, touches no policy, changes no RLS.

begin;

do $$
begin
  -- A stock Supabase project ships `supabase_realtime` already created. A bare
  -- Postgres (local `supabase db push` against a plain instance, a restored dump
  -- that dropped it) does not, and `alter publication` on a missing publication
  -- is a hard error — so create the empty publication rather than fail the chain.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;

-- Unguarded on purpose: `replica identity` is a set-to-this-value, not an add, so
-- re-running is already a no-op.
alter table public.messages replica identity full;

commit;
