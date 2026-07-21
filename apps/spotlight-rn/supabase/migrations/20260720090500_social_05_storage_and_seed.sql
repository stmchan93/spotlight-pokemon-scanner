-- Social layer — part 05: Storage bucket for post images + policies, and a tiny
-- seed so the moderation pre-filter is testable without typing real slurs.
--
-- Bucket is PRIVATE. For v1, only the owner/admin can read objects via the
-- authenticated API; public serving of APPROVED images later goes through signed
-- URLs / a CDN (gated on post_media.moderation_status='approved'), added when the
-- feed ships. This keeps unmoderated images unreachable by the public.

begin;

insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', false)
on conflict (id) do nothing;

-- Upload: authenticated users write objects they own into the post-media bucket.
drop policy if exists post_media_upload on storage.objects;
create policy post_media_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'post-media' and owner = auth.uid());

-- Read: owner or admin only (public approved-image serving comes later via signed URLs).
drop policy if exists post_media_read on storage.objects;
create policy post_media_read on storage.objects for select to authenticated
  using (bucket_id = 'post-media' and (owner = auth.uid() or public.is_admin()));

-- Update / delete: owner or admin.
drop policy if exists post_media_modify on storage.objects;
create policy post_media_modify on storage.objects for update to authenticated
  using (bucket_id = 'post-media' and (owner = auth.uid() or public.is_admin()));
drop policy if exists post_media_delete on storage.objects;
create policy post_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'post-media' and (owner = auth.uid() or public.is_admin()));

-- Seed: a harmless test term so you can prove the synchronous filter works
-- (a post whose body contains "zzblockedtest" is auto-removed). Replace/extend
-- blocked_terms with your real hard/soft wordlist via the admin path.
insert into public.blocked_terms (term, severity) values ('zzblockedtest', 'hard')
on conflict (term) do nothing;

commit;
