-- social_32: one booth per person per show (user, 2026-11-16).
--
-- social_27 allowed up to 3 active claims per account across all shows, so a
-- vendor who already held a booth was still offered "Tap here to claim your
-- vendor booth" and could claim a second one at the same show. Now a second
-- claim at the SAME show returns 'limit'; one booth at each of several shows
-- stays allowed (the 3-claim account cap is kept as a backstop).
-- One PERSON per booth is unchanged: uq_booth_claims_active.

create or replace function public.claim_booth(p_vendor_id text, p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  holder uuid;
begin
  if me is null then
    return 'unauthenticated';
  end if;
  holder := public.booth_claimer(p_vendor_id);
  if holder = me then
    return 'already_yours';
  elsif holder is not null then
    return 'taken';
  end if;
  if exists (
    select 1 from public.booth_claims
    where user_id = me and event_id = p_event_id and revoked_at is null
  ) then
    return 'limit';
  end if;
  if (select count(*) from public.booth_claims where user_id = me and revoked_at is null) >= 3 then
    return 'limit';
  end if;
  begin
    insert into public.booth_claims (vendor_id, event_id, user_id) values (p_vendor_id, p_event_id, me);
  exception when unique_violation then
    return 'taken';
  end;
  return 'claimed';
end;
$$;

-- create or replace keeps existing privileges; restated so this file stands alone.
revoke all on function public.claim_booth(text, text) from public, anon;
grant execute on function public.claim_booth(text, text) to authenticated;
