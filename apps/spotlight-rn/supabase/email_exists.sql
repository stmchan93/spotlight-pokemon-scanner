-- RPC backing the email-first "smart split" auth flow; run this in the Supabase SQL editor.
--
-- SUPERSEDED (2026-08-06): migrations/20260806090000_social_10_public_users_mirror.sql now
-- owns this function — same semantics, plus `stable` and `pg_temp` pinned in search_path.
-- Kept for history; do not re-apply this file over the migration. It reads `auth.users` on
-- purpose (the `public.users` mirror deliberately carries no email); the reasoning is
-- written out in social_10.
create or replace function public.email_exists(p_email text)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from auth.users where lower(email) = lower(p_email));
$$;
grant execute on function public.email_exists(text) to anon, authenticated;
