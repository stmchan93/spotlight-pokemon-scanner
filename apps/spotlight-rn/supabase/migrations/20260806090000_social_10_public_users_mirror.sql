-- Social layer — part 10: `public.users`, an id-only mirror of `auth.users`.
--
-- WHY: we are staying on Supabase. This is the escape hatch, not a move.
-- 18 foreign keys across social_00..social_04 point at `auth.users(id)` — GoTrue's
-- proprietary schema. That is the single most expensive thing to unwind if we ever
-- leave: every one of those constraints has to be dropped, re-pointed, and
-- re-validated against a table that does not exist yet on the other side, while the
-- app is live. Mirroring the id into a table WE own turns that migration into
-- "populate public.users from the new identity provider and repoint one trigger".
--
-- This migration does NOT re-point the 18 existing FKs. Doing that on a live
-- database means dropping and re-adding constraints on hot tables, and the payoff is
-- zero while we're still on Supabase (the mirror carries the same ids). It changes
-- the RULE for everything written from here on: new tables FK `public.users(id)`.
-- See supabase/README.md.
--
-- SAFETY: additive only. One new table, two new trigger functions, two triggers on
-- auth.users, one backfill insert, and a no-op re-creation of the pre-existing
-- `email_exists` RPC (same semantics, hardened search_path). No existing table,
-- column, constraint, or policy is altered. Transactional — if any statement fails
-- the whole file rolls back and current behavior is preserved.
--
-- PRIVILEGES: the two `create trigger ... on auth.users` statements require
-- ownership of auth.users. Run this as `postgres` (Supabase SQL editor, or
-- `supabase db push`). It will fail — cleanly, in-transaction — under a weaker role.

begin;

-- ---------------------------------------------------------------------------
-- The mirror
-- ---------------------------------------------------------------------------
-- Ids and a timestamp. Nothing else, ever. No email, no phone, no display name —
-- anything copied out of auth.users is PII that then has to be kept in sync,
-- secured, and deleted twice. The mirror exists to be a FOREIGN KEY TARGET; the
-- profile surface is already `public.user_profiles` / `public.public_profiles`.
--
-- Deliberately NOT `references auth.users(id)`: an FK here would just re-create the
-- coupling we're removing, one level down. `public` ends up with ZERO foreign keys
-- into the auth schema, and the triggers below are the whole sync mechanism.
create table if not exists public.users (
  id         uuid primary key,
  created_at timestamptz not null default now()
);

comment on table public.users is
  'Id-only mirror of auth.users. FK target for all public-schema tables — never FK auth.users directly. Kept in sync by the auth_users_mirror_* triggers. Contains no PII by design.';

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Carry auth.users.created_at across so the mirror is honest about signup order
-- from day one (a timestamp is not PII, and a wrong one is worse than none).
-- `on conflict do nothing` makes re-running this file a no-op.
insert into public.users (id, created_at)
select u.id, coalesce(u.created_at, now())
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Sync triggers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER is load-bearing, for the same reason social_07 and social_09
-- spell out: these fire as whoever performed the auth write. Signups run as
-- `supabase_auth_admin`, which has no privileges in `public` at all — an INVOKER
-- function would fail outright, and (the social_07/09 failure mode) a row-policy
-- mismatch on the mirror would drop the write SILENTLY, with no error anywhere,
-- leaving accounts that exist in auth and not in public. Definer + an explicit
-- `set search_path = public, pg_temp` closes both: it runs as the function owner
-- (postgres, who owns public.users and is exempt from its RLS), and it cannot be
-- hijacked by a temp-schema object shadowing an unqualified name.
--
-- Bodies are kept to a single statement on purpose. This runs INSIDE the signup
-- transaction: anything that raises here surfaces to the user as GoTrue's opaque
-- "Database error saving new user" and blocks the signup entirely. We do not wrap
-- it in an exception handler — swallowing the error would trade a loud failure for
-- permanent invisible drift, which is exactly the bug class social_09 was written
-- to kill. A single `insert ... on conflict do nothing` into a two-column table has
-- no realistic failure mode short of someone dropping the mirror.
create or replace function public.tg_auth_users_mirror_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.users (id, created_at)
  values (new.id, coalesce(new.created_at, now()))
  on conflict (id) do nothing;
  return null;
end;
$$;

-- Deleting the mirror row is what preserves today's `on delete cascade` semantics
-- for anything FK'd to the mirror: auth.users row goes → this fires → public.users
-- row goes → the cascade fans out from there, identically to a direct auth.users
-- cascade. This is why every FK to public.users MUST be `on delete cascade` (or
-- `on delete set null` for nullable attribution columns, matching social_02/03/04).
-- A `restrict`/`no action` FK to the mirror would raise inside this trigger and make
-- account deletion fail — including the backend's admin-API delete
-- (`_delete_supabase_auth_user`, backend/server.py).
create or replace function public.tg_auth_users_mirror_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.users where id = old.id;
  return null;
end;
$$;

drop trigger if exists auth_users_mirror_insert on auth.users;
create trigger auth_users_mirror_insert after insert on auth.users
  for each row execute function public.tg_auth_users_mirror_insert();

drop trigger if exists auth_users_mirror_delete on auth.users;
create trigger auth_users_mirror_delete after delete on auth.users
  for each row execute function public.tg_auth_users_mirror_delete();

-- No UPDATE trigger: the mirror holds no column that can change.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- First, the thing that is easy to get wrong in the other direction: this policy
-- does NOT affect foreign keys. Postgres runs referential-integrity checks with RLS
-- bypassed, so a locked-down mirror cannot break inserts into tables that reference
-- it. The read policy is therefore a pure privacy decision, free of side effects.
alter table public.users enable row level security;

-- Read: SELF ONLY. Reasoning, deliberately, because "it's just uuids" argues for
-- `using (true)`:
--   * The ids themselves are already public — follows, post_likes and comment_likes
--     all carry `select ... using (true)` (social_00/01). Nothing is protected by
--     hiding an id that the feed already hands out.
--   * But this table is the one place with the COMPLETE roster: every account,
--     including users who never posted and every `signInAnonymously()` guest, with
--     a signup timestamp. `select count(*)` and `order by created_at` turn it into a
--     total-users and signup-rate oracle for anyone holding the anon key that ships
--     inside the app bundle. That is business data we do not currently expose, and
--     it is not needed to render anything.
--   * Guests carry the `authenticated` role (social_07's note), so `to authenticated`
--     would mean "anyone with the app installed".
-- Self-read tells a client nothing it doesn't already know (its own uid) while
-- keeping the roster closed, and it is enough to assert mirror liveness from the
-- app or a test.
drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users for select to authenticated
  using (id = (select auth.uid()));

-- No insert / update / delete policy, by design: the mirror is written ONLY by the
-- SECURITY DEFINER triggers above and by service_role (which bypasses RLS). A client
-- must never be able to manufacture or remove an identity row — it is a FK target,
-- so a forged row would let it hang arbitrary rows off a user that doesn't exist.
--
-- Table grants have to be taken back explicitly, not assumed: Supabase ships
-- `alter default privileges in schema public grant all on tables to anon,
-- authenticated, service_role`, so this table arrives with INSERT/UPDATE/DELETE
-- already granted to both client roles. RLS would stop them today, but a future
-- permissive policy would then be one line away from a writable identity table.
-- Revoke first, then grant back exactly SELECT. service_role keeps its grants (it
-- bypasses RLS anyway and the backend needs them).
revoke all on public.users from anon, authenticated;
grant select on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- email_exists(text): STAYS ON auth.users. Deliberate.
-- ---------------------------------------------------------------------------
-- The obvious move is to re-point this RPC at the mirror alongside everything else.
-- It is the wrong one, for four reasons:
--
--   1. The mirror has no email, and it must not get one. Adding `email` duplicates
--      PII into a second table that then needs its own security review, its own
--      deletion story, and an UPDATE trigger. Adding `email_hash` instead only looks
--      safer: an email address has a tiny, guessable preimage space, so a hash of it
--      is reversible by dictionary in seconds — it is pseudonymised PII, not
--      anonymised, and it would be sitting in the one table whose whole point is
--      that it is boring enough not to need protecting.
--   2. Correctness. auth.users.email is live truth and it MOVES — email change,
--      confirmation, identity linking. A mirrored copy needs INSERT + UPDATE sync,
--      and a missed UPDATE fails silently in the worst possible place:
--      auth-service.ts uses this RPC to decide whether to tell a user "this account
--      does not exist" after a rejected sign-in. Stale mirror → we tell a real user
--      with a mistyped password that their account is gone. That is precisely the
--      silent-drift class social_07/social_09 exist to prevent, and here it is
--      user-facing.
--   3. It is not on the critical path for the escape hatch. Emails belong to the
--      identity provider, whoever that is. A GoTrue replacement will have its own
--      users-and-emails table, so migration day means editing ONE line in ONE
--      SECURITY DEFINER function — minutes. The 18 FKs were the expensive part, and
--      those are what the mirror addresses.
--   4. The blast radius of getting it wrong is the entire email-first sign-in flow
--      (auth-service.ts `checkEmailExists`, and the invalid-credentials
--      disambiguation below it).
--
-- So: this is the ONE remaining read of auth.users from the public schema, and it is
-- an intentional, documented, single-line one. Migration-day replacement is exactly:
--     select exists (select 1 from <new identity table> where lower(email) = lower(p_email));
--
-- Re-created here (rather than left loose in supabase/email_exists.sql, which was
-- applied by hand and never tracked) so the migrations are the source of truth about
-- this function — same reason social_07 declared `labeler_enabled`. Semantically a
-- no-op: identical body and grants. The only changes are `stable` (it reads and does
-- not write; SECURITY DEFINER functions are never inlined, so this only helps the
-- planner) and `pg_temp` pinned last in search_path, matching social_07/09.
--
-- Note for later, not changed here: `execute` is granted to `anon`, which makes this
-- an unauthenticated account-existence oracle. That is a conscious product tradeoff
-- the sign-in UX depends on today; tightening it is an app-behavior decision, not a
-- schema one.
create or replace function public.email_exists(p_email text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from auth.users where lower(email) = lower(p_email));
$$;

grant execute on function public.email_exists(text) to anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verify (run after applying; both should return 0)
-- ---------------------------------------------------------------------------
--   -- auth users missing from the mirror
--   select count(*) from auth.users u
--     left join public.users m on m.id = u.id where m.id is null;
--   -- mirror rows with no auth user
--   select count(*) from public.users m
--     left join auth.users u on u.id = m.id where u.id is null;
