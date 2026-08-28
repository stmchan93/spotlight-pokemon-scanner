-- Social layer — part 25: server-side guardrails for mandatory @handle claim.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Handles are becoming mandatory: every signed-in user claims a unique @handle
-- through a blocking screen (client work ships alongside this migration).
-- Two server gaps had to close before the client could gate on it:
--
-- 1. FORMAT WAS ENFORCED ONLY IN TYPESCRIPT. `user_profiles.handle` is citext
--    with a partial unique index (social_00) and a column write grant
--    (social_08) — but no CHECK. Any client with a valid JWT could store
--    'Ash Ketchum!!' or a 500-char string, and the /u/[handle] route's
--    dual-lane parsing (handles must never look like UUIDs) depends on the
--    format holding. The client validator allows [a-z0-9_]{3,20} starting
--    alphanumeric; the CHECK below mirrors it exactly.
--
-- 2. THE AVAILABILITY PROBE WAS STRUCTURALLY LOSSY. isHandleAvailable()
--    (auth-service.ts) reads `public_profiles`, which social_19 filters by
--    blocks, suspension, and shadowbans — so a handle held by any hidden user
--    reads as "available", then the claim hard-fails on the unique index.
--    Tolerable when handles were optional; inside a no-escape claim screen it
--    is a dead end. `handle_available()` below is SECURITY DEFINER over the
--    BASE table: it sees every row, returns only a boolean (no information
--    about WHO holds the handle leaks), and still lets the caller keep their
--    own handle.
--
-- The unique index remains the sole authority on ownership. Both the probe and
-- the client check are advisory; the claim path must still handle a 23505.

-- All handles are NULL today (the UI that could set one was removed before
-- launch), so validation is instant and cannot fail on existing rows.
alter table public.user_profiles
  add constraint ck_user_profiles_handle_format
  -- ::text deliberately: citext's own `~` matches case-insensitively, which
  -- would let 'ASH' through. The text cast makes the regex enforce lowercase
  -- storage, matching sanitizeHandleInput() which lowercases before write.
  check (handle is null or handle::text ~ '^[a-z0-9][a-z0-9_]{2,19}$');

create or replace function public.handle_available(p_handle citext)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
    from public.user_profiles
    where handle = p_handle
      -- Your own handle always reads as available to you (idempotent re-claim,
      -- and matches the client-side probe's semantics).
      and user_id is distinct from auth.uid()
  );
$$;

comment on function public.handle_available(citext) is
  'Advisory availability check for @handle claim. Reads the base table so '
  'handles held by blocked/suspended/shadowbanned users are not misreported '
  'as free. Boolean only; the partial unique index is the real enforcement.';

-- Functions default to EXECUTE for PUBLIC; this one should require a session.
revoke execute on function public.handle_available(citext) from public, anon;
grant execute on function public.handle_available(citext) to authenticated;
