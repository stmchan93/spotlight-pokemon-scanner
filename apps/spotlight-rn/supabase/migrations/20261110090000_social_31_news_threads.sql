-- Social layer — part 31: reactions on news articles.
--
-- A news article gets one hidden post the first time anyone reacts to it, so
-- likes, comments, reposts, moderation, reports and reply notifications all run
-- on the existing post machinery instead of a parallel copy of it.
--
-- `author_id` is NULL on these posts. Every trigger that reads a post's author
-- already handles NULL (`tg_notify_*`, `tg_post_likes_fame`, `tg_posts_author_count`),
-- and `posts_insert` still requires `author_id = auth.uid()`, so a client cannot
-- create one. The client's global feed read filters them out.
--
-- ROLLOUT: ship the app build that filters authorless posts BEFORE applying this
-- to an environment. An older build would list these posts in its Social feed.

begin;

alter table public.posts alter column author_id drop not null;

create table if not exists public.news_threads (
  news_item_id text primary key,                 -- backend news_items.id
  post_id      uuid not null unique references public.posts(id) on delete cascade,
  source       text not null,
  title        text not null,
  url          text not null,
  image_url    text,
  created_at   timestamptz not null default now()
);

alter table public.news_threads enable row level security;

drop policy if exists news_threads_select on public.news_threads;
create policy news_threads_select on public.news_threads
  for select to authenticated using (true);

grant select on public.news_threads to authenticated;

-- Service-role only: the backend calls this with its own copy of the headline, so
-- no client ever chooses the text shown under a publisher's name.
create or replace function public.ensure_news_thread(
  p_news_item_id text,
  p_title        text,
  p_source       text,
  p_url          text,
  p_image_url    text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_post_id uuid;
begin
  -- Two first-reactors at once must not leave an orphan post behind.
  perform pg_advisory_xact_lock(hashtext('news_thread:' || p_news_item_id));

  select post_id into v_post_id from public.news_threads where news_item_id = p_news_item_id;
  if v_post_id is not null then
    return v_post_id;
  end if;

  insert into public.posts (author_id, body, moderation_checked_at)
  values (null, p_title, now())
  returning id into v_post_id;

  -- The publisher's headline is not user content: the word-list prefilter that
  -- ran on the insert must not hide the thread.
  update public.posts set content_status = 'visible' where id = v_post_id;

  insert into public.news_threads (news_item_id, post_id, source, title, url, image_url)
  values (p_news_item_id, v_post_id, p_source, p_title, p_url, p_image_url);

  return v_post_id;
end;
$$;

revoke all on function public.ensure_news_thread(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ensure_news_thread(text, text, text, text, text) to service_role;

comment on table public.news_threads is
  'Maps a backend news item to the hidden authorless post that carries its reactions.';

commit;
