-- ============================================================================
-- REVIEW BEFORE APPLYING — this touches the LIVE user_profiles (auth) table.
-- ============================================================================
-- Deliberately NOT in migrations/ so `supabase db push` does NOT run it. Apply it
-- consciously, on a preview branch / dev project first.
--
-- REVISED 2026-07-23 after a security review of the original draft. The original
-- would have (a) left the legacy dashboard policies in place, ORing away its own
-- guard, (b) published moderation columns to every client, and (c) silently broken
-- follower counts. See docs/portfolio-social-phase-2-public-profiles-follow-2026-07-23.md.
--
-- PREREQUISITE — push this migration FIRST, or follower counts break silently:
--   supabase/migrations/20260723090000_social_07_public_profiles_view_counter_triggers.sql
-- It creates the public_profiles view this file's model depends on, and makes the
-- counter triggers SECURITY DEFINER so they can still touch the followee's row
-- once the self-only UPDATE policy below is live.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT — one check left; the other two are now handled automatically.
-- ---------------------------------------------------------------------------
--  1. Confirm the social migrations are applied. As of 2026-07-23 they were NOT:
--     a read of the live staging schema found user_profiles carrying only
--     user_id / display_name / avatar_url / admin_enabled / labeler_enabled /
--     created_at / updated_at, and NONE of the social tables present. This file
--     references `status` and `is_shadowbanned`, so it will fail (safely — the
--     whole thing is one transaction) until social_00..social_07 are pushed.
--       select column_name from information_schema.columns
--        where table_schema='public' and table_name='user_profiles' order by 1;
--
--  2. (was: dump the policy list) — no longer needed. The DO block below
--     enumerates pg_policies and drops whatever it finds, so there is no list of
--     policy names to keep in sync.
--
--  3. (was: confirm the trigger migration landed) — no longer needed, provided
--     you push migrations in order; social_07 carries the SECURITY DEFINER fix.
--     Verify after the fact if you like:
--       select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        where n.nspname='public' and p.proname in ('tg_follows_counts','tg_posts_author_count');
--
-- AFTER APPLYING: watch Postgres logs for `42501` on user_profiles for a few days.
-- The app swallows RLS rejections — upsertProfile returns a synthetic profile and
-- updateProfile returns null — so a broken policy shows up as "my edits don't
-- save", never as an error. (auth-service.ts, the catch blocks in those two.)
-- ============================================================================

begin;

alter table public.user_profiles enable row level security;

-- ---------------------------------------------------------------------------
-- Drop EVERY pre-existing policy on the table first.
-- ---------------------------------------------------------------------------
-- Not a hand-written list of names. Permissive policies OR together, so a single
-- policy we failed to name would silently neutralize everything below — the
-- original draft did exactly that, missing the real dashboard policies
-- (`user_profiles_select_own` / `_insert_own` / `_update_own`, per
-- docs/supabase-auth-phase1-setup-2026-04-19.md) and leaving an unrestricted
-- self-update in place. That would let a user PATCH their own row with
-- {"admin_enabled": true} using nothing but the bundled anon key and their JWT.
--
-- Enumerating pg_policies removes the guesswork: whatever is there, goes.
do $$
declare
  existing record;
begin
  for existing in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'user_profiles'
  loop
    execute format('drop policy if exists %I on public.user_profiles', existing.policyname);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read: SELF ONLY. Cross-user reads go through public.public_profiles.
-- ---------------------------------------------------------------------------
-- Not `using (true)`: RLS filters rows, not columns, so a public read policy here
-- would also expose status / is_shadowbanned / admin_enabled / labeler_enabled. A
-- shadowban the shadowbanned user can query is not a shadowban, and admin_enabled
-- is the complete moderator roster.
--
-- `auth.uid()` is wrapped in a subselect throughout so the planner treats it as an
-- InitPlan instead of re-evaluating it per row.
create policy user_profiles_self_read on public.user_profiles for select to authenticated
  using (user_id = (select auth.uid()));

-- Self insert (profile onboarding / upsert).
create policy user_profiles_self_insert on public.user_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Write: self only, with the sensitive columns fenced off by GRANTs, not by a
-- subquery in the policy.
-- ---------------------------------------------------------------------------
-- The original draft pinned status / is_shadowbanned / admin_enabled by re-reading
-- user_profiles from inside a policy ON user_profiles. Three reasons column
-- privileges are better:
--   1. It covered only 3 of the sensitive columns. `is_verified`, `reputation`,
--      `follower_count`, and `labeler_enabled` stayed self-writable — any user
--      could grant themselves the blue check or inflate their own follower count.
--      The JS key whitelist in updateProfile is not a boundary; PostgREST is a
--      direct client and the anon key ships in the app bundle.
--   2. It is one edit away from `42P17 infinite recursion`. It survives today only
--      because the SELECT policy it recurses into is sublink-free. Add an EXISTS to
--      the read policy — e.g. a block-aware read in Phase 2b — and every profile
--      save starts failing.
--   3. On a concurrent first-write race the subquery returns no rows, yielding
--      NULL, which fails WITH CHECK and rejects a legitimate save.
-- Column privileges are checked independently of RLS, cannot be OR'd away by a
-- stray permissive policy, and have no NULL semantics.
create policy user_profiles_self_update on public.user_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke update on public.user_profiles from authenticated;
-- user_id is included deliberately: PostgREST's upsert names it in the DO UPDATE
-- SET list, and the policy above already pins it to the caller's own id, so a write
-- can only ever set it to the value it already holds.
grant update (user_id, display_name, avatar_url, handle, bio, location, social_link)
  on public.user_profiles to authenticated;

-- No DELETE policy, on purpose: nothing client-side deletes profiles. Rows go away
-- via `on delete cascade` from auth.users, and FK referential actions bypass RLS,
-- so account deletion is unaffected.
--
-- No `anon` policy, on purpose: guests sign in anonymously and carry the
-- `authenticated` role. Do not "fix" this by adding one.

-- ---------------------------------------------------------------------------
-- Admin moderation writes
-- ---------------------------------------------------------------------------
-- Kept as a policy for now, but NOT sufficient on its own: the REVOKE above strips
-- column-level UPDATE from `authenticated`, and admins hold that same role — so an
-- admin's UPDATE to status / is_shadowbanned / admin_enabled is refused by column
-- privileges before RLS is ever consulted.
--
-- The right shape is a SECURITY DEFINER RPC — admin_set_user_status(p_user_id,
-- p_status) guarded by public.is_admin() — because it can write the matching
-- moderation_actions audit row in the same transaction, which a bare UPDATE policy
-- cannot guarantee. Until that RPC exists, moderation is a service-role operation
-- (service_role has BYPASSRLS and is unaffected by everything in this file).
create policy user_profiles_admin_update on public.user_profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;
