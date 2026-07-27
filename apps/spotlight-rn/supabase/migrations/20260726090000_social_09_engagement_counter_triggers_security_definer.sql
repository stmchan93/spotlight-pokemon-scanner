-- Social layer — part 09: make the engagement counter triggers SECURITY DEFINER.
--
-- Same bug class social_07 fixed for tg_follows_counts / tg_posts_author_count,
-- but for the remaining engagement counters: a comment/like on SOMEONE ELSE'S
-- post or comment fires a trigger that UPDATEs the *other* user's row
-- (posts.comment_count, posts.like_count, comments.like_count). Trigger functions
-- run as the invoking user, and the posts/comments RLS UPDATE policies are
-- author-only — so RLS SILENTLY drops the counter bump (no error). Result:
-- cross-user comment counts and like counts under-count.
--
-- Verified live: a second user's reply left post.comment_count at 1 (should be 2),
-- and their like on the author's comment left like_count at 0.
--
-- Fix: re-create the three functions with `security definer set search_path`
-- (bodies byte-identical to social_01). Idempotent (create or replace), additive,
-- transactional. Does NOT change RLS or any policy.

begin;

create or replace function public.tg_comments_post_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create or replace function public.tg_post_likes_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create or replace function public.tg_comment_likes_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    update public.comments set like_count = like_count + 1 where id = new.comment_id;
  elsif tg_op = 'DELETE' then
    update public.comments set like_count = greatest(like_count - 1, 0) where id = old.comment_id;
  end if;
  return null;
end;
$$;

commit;
