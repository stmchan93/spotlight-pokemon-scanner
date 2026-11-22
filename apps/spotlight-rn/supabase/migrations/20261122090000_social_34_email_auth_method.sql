-- Social layer — part 34: email_auth_method(text).
--
-- Email-first login asks for the email, then routes to the right next step. A
-- boolean `email_exists` can't do that: an account created with Sign in with
-- Google/Apple has an email but no password, so the password step fails and the
-- old flow told those users "This account does not exist". This RPC says HOW the
-- account signs in so the app can send them to the Google/Apple button instead.
--
-- Returns one of:
--   'none'     no auth.users row with that email (case-insensitive). Anonymous
--              (guest) users have no email, so they land here naturally.
--   'password' the account has a password, regardless of linked social identities
--   'google'   no password, has a google identity
--   'apple'    no password, has an apple identity (google wins if both)
--   'oauth'    no password, some other/unknown provider
--
-- Reads auth.users / auth.identities for the same reasons social_10 keeps
-- email_exists on auth.users (the public.users mirror deliberately holds no
-- email). Like email_exists it is granted to anon and is therefore an
-- unauthenticated account-existence oracle — the same accepted tradeoff, now also
-- disclosing the sign-in method. email_exists is left untouched (old builds call it).
--
-- Additive, idempotent, transactional.

begin;

create or replace function public.email_auth_method(p_email text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  with matched as (
    select u.id, coalesce(u.encrypted_password, '') <> '' as has_password
    from auth.users u
    where lower(u.email) = lower(p_email)
  ),
  providers as (
    select i.provider
    from auth.identities i
    join matched m on m.id = i.user_id
  )
  select case
    when not exists (select 1 from matched) then 'none'
    when exists (select 1 from matched where has_password) then 'password'
    when exists (select 1 from providers where provider = 'google') then 'google'
    when exists (select 1 from providers where provider = 'apple') then 'apple'
    else 'oauth'
  end;
$$;

revoke all on function public.email_auth_method(text) from public;
grant execute on function public.email_auth_method(text) to anon, authenticated;

commit;

-- Verify (after applying):
--   select public.email_auth_method('nobody-' || gen_random_uuid() || '@example.com');  -- 'none'
--   select public.email_auth_method('<a password account email>');                       -- 'password'
