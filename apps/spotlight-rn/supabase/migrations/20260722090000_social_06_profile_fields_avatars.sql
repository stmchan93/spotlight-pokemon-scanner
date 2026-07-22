-- Social layer — part 06: extended profile fields + public avatars bucket.
--
-- Adds the profile fields the mobile Portfolio profile + Edit Profile screens
-- read/write (location, social link) plus verification + reputation, and a
-- PUBLIC `avatars` bucket. Unlike post-media (private, owner-only), avatars are
-- shown on public profiles, so they are world-readable; only the owner can
-- write/replace their own object.

begin;

-- Profile fields (additive; matches the social_00 add-column style).
alter table public.user_profiles add column if not exists location    text;
alter table public.user_profiles add column if not exists social_link text;
alter table public.user_profiles add column if not exists is_verified boolean not null default false;
alter table public.user_profiles add column if not exists reputation  integer not null default 0;

-- Public avatars bucket.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Read: public — avatars render on public profiles.
drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select to public
  using (bucket_id = 'avatars');

-- Upload: authenticated users write objects they own.
drop policy if exists avatars_upload on storage.objects;
create policy avatars_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and owner = auth.uid());

-- Update / delete: owner only.
drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid());
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid());

commit;
