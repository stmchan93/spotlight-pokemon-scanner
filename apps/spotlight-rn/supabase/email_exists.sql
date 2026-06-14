-- RPC backing the email-first "smart split" auth flow; run this in the Supabase SQL editor.
create or replace function public.email_exists(p_email text)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from auth.users where lower(email) = lower(p_email));
$$;
grant execute on function public.email_exists(text) to anon, authenticated;
