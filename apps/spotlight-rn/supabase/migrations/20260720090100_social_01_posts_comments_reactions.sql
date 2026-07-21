-- Social layer — part 01: posts, post media, comments, and reactions (likes).
-- All-new tables. Full RLS. Safe/additive.

begin;

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id                   uuid primary key default gen_random_uuid(),
  author_id            uuid not null references auth.users(id) on delete cascade,
  body                 text,
  card_id              text,                       -- OPTIONAL Scrydex card id (showcase); no cross-DB FK
  content_status       text not null default 'visible',   -- pending | visible | removed
  moderation_checked_at timestamptz,               -- null = not yet seen by the async AI pass
  like_count           integer not null default 0,
  comment_count        integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz                 -- soft-delete (moderation/audit)
);
create index if not exists idx_posts_author_created on public.posts (author_id, created_at desc);
create index if not exists idx_posts_feed on public.posts (created_at desc)
  where content_status = 'visible' and deleted_at is null;
create index if not exists idx_posts_unchecked on public.posts (created_at)
  where moderation_checked_at is null;

drop trigger if exists set_updated_at on public.posts;
create trigger set_updated_at before update on public.posts
  for each row execute function public.tg_set_updated_at();

-- post_count on the author's profile.
create or replace function public.tg_posts_author_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.user_profiles set post_count = post_count + 1 where user_id = new.author_id;
  elsif tg_op = 'DELETE' then
    update public.user_profiles set post_count = greatest(post_count - 1, 0) where user_id = old.author_id;
  end if;
  return null;
end;
$$;
drop trigger if exists posts_author_count on public.posts;
create trigger posts_author_count after insert or delete on public.posts
  for each row execute function public.tg_posts_author_count();

-- ---------------------------------------------------------------------------
-- Post media (images live in Supabase Storage; this is the metadata row)
-- ---------------------------------------------------------------------------
create table if not exists public.post_media (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references public.posts(id) on delete cascade,
  storage_path      text not null,               -- object key in the 'post-media' bucket
  width             integer,
  height            integer,
  blurhash          text,
  moderation_status text not null default 'pending',  -- pending | approved | rejected
  position          integer not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists idx_post_media_post on public.post_media (post_id, position);
create index if not exists idx_post_media_pending on public.post_media (created_at)
  where moderation_status = 'pending';

-- ---------------------------------------------------------------------------
-- Comments (single-level threading)
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id                   uuid primary key default gen_random_uuid(),
  post_id              uuid not null references public.posts(id) on delete cascade,
  author_id            uuid not null references auth.users(id) on delete cascade,
  parent_comment_id    uuid references public.comments(id) on delete cascade,
  body                 text not null,
  content_status       text not null default 'visible',
  moderation_checked_at timestamptz,
  like_count           integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index if not exists idx_comments_post on public.comments (post_id, created_at);
create index if not exists idx_comments_unchecked on public.comments (created_at)
  where moderation_checked_at is null;

drop trigger if exists set_updated_at on public.comments;
create trigger set_updated_at before update on public.comments
  for each row execute function public.tg_set_updated_at();

-- comment_count on the parent post.
create or replace function public.tg_comments_post_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;
drop trigger if exists comments_post_count on public.comments;
create trigger comments_post_count after insert or delete on public.comments
  for each row execute function public.tg_comments_post_count();

-- ---------------------------------------------------------------------------
-- Reactions (likes)
-- ---------------------------------------------------------------------------
create table if not exists public.post_likes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create or replace function public.tg_post_likes_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;
drop trigger if exists post_likes_count on public.post_likes;
create trigger post_likes_count after insert or delete on public.post_likes
  for each row execute function public.tg_post_likes_count();

create or replace function public.tg_comment_likes_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.comments set like_count = like_count + 1 where id = new.comment_id;
  elsif tg_op = 'DELETE' then
    update public.comments set like_count = greatest(like_count - 1, 0) where id = old.comment_id;
  end if;
  return null;
end;
$$;
drop trigger if exists comment_likes_count on public.comment_likes;
create trigger comment_likes_count after insert or delete on public.comment_likes
  for each row execute function public.tg_comment_likes_count();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.posts         enable row level security;
alter table public.post_media    enable row level security;
alter table public.comments      enable row level security;
alter table public.post_likes    enable row level security;
alter table public.comment_likes enable row level security;

-- posts: visible to all (minus blocks) when live; author + admin always; author/admin write.
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated using (
  deleted_at is null and (
    author_id = auth.uid()
    or public.is_admin()
    or (content_status = 'visible' and not public.is_blocked(auth.uid(), author_id))
  )
);
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts for insert to authenticated
  with check (author_id = auth.uid());
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());
drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- post_media: readable when the parent post is readable AND the image is approved
-- (owner/admin can always see own, incl. pending).
drop policy if exists post_media_select on public.post_media;
create policy post_media_select on public.post_media for select to authenticated using (
  exists (
    select 1 from public.posts p
    where p.id = post_media.post_id
      and p.deleted_at is null
      and (
        p.author_id = auth.uid()
        or public.is_admin()
        or (post_media.moderation_status = 'approved'
            and p.content_status = 'visible'
            and not public.is_blocked(auth.uid(), p.author_id))
      )
  )
);
drop policy if exists post_media_write on public.post_media;
create policy post_media_write on public.post_media for all to authenticated
  using (exists (select 1 from public.posts p where p.id = post_media.post_id and (p.author_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.posts p where p.id = post_media.post_id and p.author_id = auth.uid()));

-- comments: same shape as posts.
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated using (
  deleted_at is null and (
    author_id = auth.uid()
    or public.is_admin()
    or (content_status = 'visible' and not public.is_blocked(auth.uid(), author_id))
  )
);
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check (author_id = auth.uid());
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- likes: public counts; you manage only your own like row; can't like blocked authors' content.
drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes for select to authenticated using (true);
drop policy if exists post_likes_insert on public.post_likes;
create policy post_likes_insert on public.post_likes for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from public.posts p where p.id = post_id and not public.is_blocked(auth.uid(), p.author_id)));
drop policy if exists post_likes_delete on public.post_likes;
create policy post_likes_delete on public.post_likes for delete to authenticated using (user_id = auth.uid());

drop policy if exists comment_likes_select on public.comment_likes;
create policy comment_likes_select on public.comment_likes for select to authenticated using (true);
drop policy if exists comment_likes_insert on public.comment_likes;
create policy comment_likes_insert on public.comment_likes for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists comment_likes_delete on public.comment_likes;
create policy comment_likes_delete on public.comment_likes for delete to authenticated using (user_id = auth.uid());

commit;
