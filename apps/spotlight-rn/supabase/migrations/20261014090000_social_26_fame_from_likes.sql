-- Social layer — part 26: Fame (`user_profiles.reputation`) = likes received.
--
-- social_06 added the column and the profile header shows it as "Fame", but
-- nothing ever wrote it, so every profile read 0.
--
-- Rule: +1 to the AUTHOR when someone else likes their post or comment, -1 on
-- unlike. Self-likes don't count. If the liked post/comment is hard-deleted,
-- the cascaded like deletes can no longer find the author, so the fame earned
-- stays — the same as a soft delete, which leaves the like rows in place.
--
-- security definer for the same reason as social_09: the liker's RLS-gated
-- UPDATE of another user's profile row would otherwise be silently dropped.
--
-- Idempotent, additive, transactional. Safe to re-run.

begin;

create or replace function public.tg_post_likes_fame()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  liker  uuid := coalesce(new.user_id, old.user_id);
  author uuid;
begin
  select author_id into author from public.posts where id = coalesce(new.post_id, old.post_id);
  if author is null or author = liker then
    return null;
  end if;
  if tg_op = 'INSERT' then
    update public.user_profiles set reputation = reputation + 1 where user_id = author;
  else
    update public.user_profiles set reputation = greatest(reputation - 1, 0) where user_id = author;
  end if;
  return null;
end;
$$;

drop trigger if exists post_likes_fame on public.post_likes;
create trigger post_likes_fame after insert or delete on public.post_likes
  for each row execute function public.tg_post_likes_fame();

create or replace function public.tg_comment_likes_fame()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  liker  uuid := coalesce(new.user_id, old.user_id);
  author uuid;
begin
  select author_id into author from public.comments where id = coalesce(new.comment_id, old.comment_id);
  if author is null or author = liker then
    return null;
  end if;
  if tg_op = 'INSERT' then
    update public.user_profiles set reputation = reputation + 1 where user_id = author;
  else
    update public.user_profiles set reputation = greatest(reputation - 1, 0) where user_id = author;
  end if;
  return null;
end;
$$;

drop trigger if exists comment_likes_fame on public.comment_likes;
create trigger comment_likes_fame after insert or delete on public.comment_likes
  for each row execute function public.tg_comment_likes_fame();

-- Backfill from the likes that exist today (others' likes on surviving content).
with received as (
  select p.author_id as user_id, count(*) as n
    from public.post_likes l join public.posts p on p.id = l.post_id
   where l.user_id <> p.author_id
   group by p.author_id
  union all
  select c.author_id, count(*)
    from public.comment_likes l join public.comments c on c.id = l.comment_id
   where l.user_id <> c.author_id
   group by c.author_id
), truth as (
  select up.user_id, coalesce(sum(r.n), 0)::integer as n
    from public.user_profiles up
    left join received r on r.user_id = up.user_id
   group by up.user_id
)
update public.user_profiles up
   set reputation = truth.n
  from truth
 where truth.user_id = up.user_id
   and up.reputation is distinct from truth.n;

commit;
