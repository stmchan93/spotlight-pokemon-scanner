-- Auth — part 00: the BASE `public.user_profiles` table.
--
-- WHY THIS FILE EXISTS (added 2026-08-06, backdated on purpose):
-- `user_profiles` was created by hand in the Supabase SQL editor on 2026-04-19 from
-- docs/supabase-auth-phase1-setup-2026-04-19.md, and was never captured as a
-- migration. Every social_00..social_10 file then builds on it —
-- social_00 opens with `alter table public.user_profiles add column ...`.
--
-- Consequence: the migration chain was NOT self-contained. `supabase db push`
-- against a fresh project failed at social_00 with "relation public.user_profiles
-- does not exist". That was discovered while standing up the staging project.
-- This file makes the chain reproducible from zero.
--
-- The timestamp is deliberately 20260419210000 — before social_00 — so a fresh
-- database applies it first and reaches the same end state as production.
--
-- ---------------------------------------------------------------------------
-- IMPORTANT, FOR THE PRODUCTION PROJECT (lvnjshymwvagwadqeofm)
-- ---------------------------------------------------------------------------
-- Production ALREADY has this table. Do NOT execute this file there. Mark it as
-- applied in the ledger instead, so the migration history lines up without running
-- anything:
--
--     supabase migration repair --status applied 20260419210000
--
-- Everything here is `if not exists`, so executing it on production would be
-- harmless in itself — but see the RLS note below for the one thing that would
-- NOT have been harmless if this file had been a faithful copy of the doc.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY OMITTED: the three phase-1 RLS policies
-- ---------------------------------------------------------------------------
-- The 2026-04-19 doc also created `user_profiles_select_own`,
-- `user_profiles_insert_own` and `user_profiles_update_own`, and enabled RLS.
-- Those are NOT reproduced here, on purpose:
--
--   * social_08 (user_profiles RLS hardening) exists specifically to DROP every
--     pre-existing policy on this table — it enumerates `pg_policies` and drops
--     them by name rather than using a hand-written list, precisely so legacy
--     dashboard policies cannot survive and OR themselves back into the new,
--     tighter rules. Re-creating the permissive phase-1 policies here would
--     reintroduce exactly what social_08 was written to remove.
--   * social_08 is also the file that adds the column-level GRANT/REVOKE fencing
--     which is what actually protects `admin_enabled`, `status`,
--     `is_shadowbanned`, `labeler_enabled`, `is_verified`, `reputation` and the
--     denormalized counters.
--
-- So RLS on `user_profiles` is owned end-to-end by social_08. On a fresh database
-- the window between this file and social_08 contains no client traffic — only
-- migrations running as `postgres` — so leaving RLS off until social_08 turns it
-- on is safe and produces an end state identical to production.
--
-- Columns added later are likewise NOT duplicated here: social_00 adds handle, bio,
-- status, is_shadowbanned, the counters and admin_enabled; social_06 adds location,
-- social_link, is_verified, reputation; social_07 declares labeler_enabled (which,
-- like this table, had only ever existed as a dashboard change).

begin;

create table if not exists public.user_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.user_profiles is
  'Per-user profile. Created by hand 2026-04-19; captured as a migration 2026-08-06 so the chain replays from zero. RLS is owned by social_08, not this file.';

-- Kept from the phase-1 SQL as-is. social_00 later adds its own `set_updated_at`
-- trigger using the shared `tg_set_updated_at()` helper; both are idempotent and
-- converge, and this one is what production has been running since April.
create or replace function public.touch_user_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row execute function public.touch_user_profiles_updated_at();

commit;
