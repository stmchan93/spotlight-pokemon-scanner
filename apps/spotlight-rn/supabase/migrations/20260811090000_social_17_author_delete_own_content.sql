-- Social layer — part 17: let an author delete their OWN posts and comments,
-- and make SOFT delete a correct operation rather than a silent counter leak.
--
-- NOT YET APPLIED anywhere. Apply to staging first, then production.
--
-- ===========================================================================
-- WHAT WAS ALREADY TRUE (read this before assuming this file adds the feature)
-- ===========================================================================
-- The headline ask — "an author may delete their own content, nobody else's" —
-- was ALREADY authorized when social_01 created the tables. This file does not
-- create that permission. It closes the three things around it that were not
-- true, and picks the delete SHAPE the client is being written against.
--
--   1. POLICIES EXIST. social_01 ships, verbatim:
--
--        create policy posts_delete on public.posts for delete to authenticated
--          using (author_id = auth.uid() or public.is_admin());
--        create policy comments_delete on public.comments for delete to authenticated
--          using (author_id = auth.uid() or public.is_admin());
--
--      Author-or-admin, on both tables, since day one. Re-creating them here
--      would be churn, so this file leaves them exactly as they are. (They are
--      re-listed in the verification footer so a human can confirm the live DB
--      actually matches the repo.)
--
--   2. THE COUNTER TRIGGERS ALREADY HANDLE HARD DELETE. `tg_posts_author_count`
--      and `tg_comments_post_count` have had an `elsif tg_op = 'DELETE'` branch
--      since social_01, and both are SECURITY DEFINER since social_07/social_09
--      — which matters here, because decrementing `post_count` writes to a
--      `user_profiles` row that an ADMIN deleting someone else's post does not
--      own, and social_08's self-only UPDATE policy would drop that write
--      SILENTLY. That hazard is already paid for. They are INSERT/DELETE-only,
--      though, which is exactly the hole item 4 below fills.
--
--   3. THE FK CASCADES ARE COMPLETE FOR HARD DELETE. Everything that hangs off a
--      post or a comment is `on delete cascade`, so a hard delete orphans no row
--      in this database:
--
--        post_media.post_id            -> posts(id)     cascade   (social_01)
--        comments.post_id              -> posts(id)     cascade   (social_01)
--        comments.parent_comment_id    -> comments(id)  cascade   (social_01)
--        post_likes.post_id            -> posts(id)     cascade   (social_01)
--        comment_likes.comment_id      -> comments(id)  cascade   (social_01)
--        notifications.post_id         -> posts(id)     cascade   (social_03)
--        notifications.comment_id      -> comments(id)  cascade   (social_03)
--
--      Nothing needed adding, so this file adds no constraint. Two things that
--      are NOT covered, and cannot be fixed with an FK, are called out under
--      "WHY SOFT" below: `reports.target_id` / `moderation_actions.target_id`
--      (bare uuids, deliberately no FK) and the Storage objects behind
--      `post_media.storage_path` (a different subsystem entirely — deleting the
--      metadata row does not delete the image in the bucket).
--
-- ===========================================================================
-- 4. THE ACTUAL BUG THIS FILE FIXES: counters do not survive a SOFT delete
-- ===========================================================================
-- `posts.deleted_at` and `comments.deleted_at` have existed since social_01,
-- annotated "soft-delete (moderation/audit)", and `posts_select`/`comments_select`
-- both start with `deleted_at is null` — so setting that column already hides a
-- row from every reader. What has never existed is anything that NOTICES the
-- transition. Both counter triggers fire on INSERT and DELETE only:
--
--     create trigger posts_author_count   after insert or delete on public.posts ...
--     create trigger comments_post_count  after insert or delete on public.comments ...
--
-- A soft delete is an UPDATE. So today, soft-deleting a post decrements nothing:
-- the post vanishes from every feed while `user_profiles.post_count` keeps
-- counting it, forever, with no error anywhere. Same shape for a soft-deleted
-- comment and `posts.comment_count`. That drift is unrecoverable without a full
-- recount, which is why it has to be fixed in the same migration that makes soft
-- delete reachable — not after someone uses it.
--
-- The fix is two new AFTER UPDATE triggers that fire ONLY on a real deleted_at
-- transition (`when (old.deleted_at is distinct from new.deleted_at)`), plus a
-- guard added to the existing DELETE branches so that HARD-deleting a row that
-- was ALREADY soft-deleted does not decrement a second time.
--
-- The WHEN clause is load-bearing, not decoration. `posts` is UPDATEd on every
-- like and every comment (the `like_count` / `comment_count` triggers do exactly
-- that), so an unconditional AFTER UPDATE trigger here would execute a plpgsql
-- function on the hottest write path in the app. With the WHEN clause Postgres
-- evaluates one boolean and skips the call. The column list (`update of
-- deleted_at`) is deliberately NOT used: it fires on whether a column is NAMED
-- in the SET list, not on whether its value changed, which is the weaker and
-- more surprising of the two guards.
--
-- Counting keys off `deleted_at`, never off `content_status`. `content_status`
-- is shared with the async moderation worker (backend/social_moderation_worker.py
-- scans `moderation_checked_at is null` and writes `content_status='removed'`
-- as service_role), so a worker pass CAN land on a post the author just deleted
-- and overwrite the `'deleted'` sentinel. `deleted_at` is monotonic, owned by
-- this path alone, and is the column RLS already gates on — so it is the one the
-- counters trust.
--
-- ===========================================================================
-- 5. HARD DELETE vs SOFT DELETE — the decision, and why
-- ===========================================================================
-- DECISION: SOFT delete (`deleted_at = now()`, `content_status = 'deleted'`) is
-- the intended shape. This migration makes it correct and makes it work; it also
-- leaves hard delete fully functional, so the client can flip
-- `USE_SOFT_DELETE` in src/features/social/social-service.ts on its own schedule
-- without a second migration.
--
-- WHY SOFT
--   * The usual objection — "soft delete means every read path has to filter it"
--     — does not apply, because that cost is ALREADY PAID. Every read in
--     social-service.ts already carries BOTH filters today:
--
--         .is('deleted_at', null).neq('content_status', 'deleted')
--
--     in `fetchPosts` and `fetchComments`, and dm-service.ts drops `'deleted'`
--     alongside `'removed'`. `'deleted'` is an established sentinel in the read
--     layer that nothing has ever written. Soft delete costs zero new filters.
--     Hard delete, by contrast, throws that existing machinery away.
--
--   * HARD DELETE DESTROYS THE EVIDENCE FOR AN OPEN REPORT. `reports.target_id`
--     and `moderation_actions.target_id` are bare `uuid not null` columns with
--     NO foreign key (social_04) — deliberately, because one column addresses
--     four target types. Nothing cascades them. So a hard delete leaves an open
--     report pointing at a row that no longer exists, and an admin opening the
--     queue sees a report they cannot judge. Worse, it hands a user a reliable
--     way to erase reported content before it is reviewed: report-threshold
--     auto-hide (`tg_reports_threshold`) sets `content_status='pending'`, the
--     author notices their post went quiet, and deleting it removes the thing
--     the moderator was about to look at. Soft delete keeps the row addressable
--     by `target_id` while making it invisible to readers — which is the entire
--     reason social_01 put `deleted_at` there.
--
--   * HARD DELETE RETROACTIVELY ERASES NOTIFICATIONS. `notifications.post_id`
--     and `.comment_id` are `on delete cascade`, so deleting a post silently
--     deletes notifications other people have already RECEIVED AND READ. Their
--     unread badge and their history change underneath them for an event that
--     genuinely happened — the same reasoning social_11 used to make the notify
--     triggers INSERT-only ("un-liking should not retract a notification you may
--     already have read"). Soft delete leaves those rows intact; the deep link
--     lands on a post that is gone, which is the ordinary, expected outcome.
--
--   * The Storage objects behind `post_media.storage_path` are NOT deleted by
--     either shape — the cascade removes the metadata row, not the bytes in the
--     bucket. Hard delete makes those bytes UNREACHABLE garbage (nothing records
--     the path any more); soft delete keeps the path, so a future retention job
--     can actually find and purge them. Neither shape cleans up today; only one
--     leaves the problem solvable.
--
-- WHAT SOFT DELETE COSTS, stated honestly
--   * Rows accumulate. There is no retention job yet. Right-to-erasure and
--     storage reclamation both become a scheduled service_role job that hard-
--     deletes rows soft-deleted more than N days ago. That job is future work
--     and is NOT in this file.
--   * `content_status = 'deleted'` is advisory only, for the reason in section 4
--     (the moderation worker can overwrite it). `deleted_at is not null` is the
--     authoritative "this is gone" signal, it is the one RLS enforces, and the
--     client filters on both — so a clobbered sentinel still hides the row.
--
-- ===========================================================================
-- 6. THE OTHER THING SOFT DELETE NEEDS: the author must see their own tombstone
-- ===========================================================================
-- `posts_select` / `comments_select` currently open with an unconditional
-- `deleted_at is null and (...)`, which hides a soft-deleted row from EVERYONE,
-- its author included. That breaks the write that creates it:
--
--   * Postgres applies SELECT policies to an UPDATE's RETURNING rows, and to the
--     rows an UPDATE reads to satisfy its WHERE clause.
--   * social-service.ts's `deleteOwnedRow` asks for the affected rows back with
--     `.select('id')` — on purpose, because RLS refuses SILENTLY and an empty
--     result is the ONLY way the client can tell "deleted" from "refused".
--   * The NEW row version has `deleted_at` set, so it fails the SELECT policy,
--     so the RETURNING comes back empty (or errors), so a soft delete that
--     actually succeeded reports failure and the UI un-hides the row.
--
-- So both policies are re-created with `deleted_at is null` moved OFF the
-- author/admin branches and onto the public branch only. Net effect, stated
-- precisely:
--
--   * An author can see their own soft-deleted rows. The client filters them out
--     anyway (`.is('deleted_at', null)`), so nothing new renders; this exists so
--     the RETURNING read works.
--   * An admin can see soft-deleted rows. This is the point of soft delete —
--     an admin who cannot read the tombstone gains nothing from keeping it.
--   * EVERY OTHER READER is unchanged, byte for byte: still
--     `deleted_at is null and content_status = 'visible' and not is_blocked(...)`.
--     Deleted content does not become visible to anyone it was not visible to.
--
-- The rest of each policy is copied verbatim from social_01 so the diff is one
-- moved conjunct. In particular `auth.uid()` is left un-wrapped rather than
-- promoted to the `(select auth.uid())` InitPlan form social_08 uses — that is a
-- real optimization, but it belongs in a migration whose subject is planner
-- behavior, not in one that is already changing delete semantics.
--
-- One planner note, since the move is not free: `deleted_at is null` stops being
-- a top-level AND conjunct on the policy and becomes one branch of an OR, so the
-- policy alone can no longer be pushed into `idx_posts_feed` (the partial index
-- on `content_status = 'visible' and deleted_at is null`). That index is still
-- used, because `fetchPosts` puts BOTH predicates in the query itself
-- (`.is('deleted_at', null).neq('content_status', 'deleted')`) — the policy was
-- never what selected it. The pre-existing `is_admin()` / `is_blocked()` OR
-- branches already made the policy quals a post-scan filter regardless.
--
-- ===========================================================================
-- 7. REPLY CASCADE (soft delete only)
-- ===========================================================================
-- Hard delete removes a comment's replies for free: `comments.parent_comment_id`
-- is `on delete cascade`. Soft delete does not fire that cascade, and the
-- difference is USER-VISIBLE rather than cosmetic — comments-sheet.tsx treats a
-- comment whose parent is missing from the fetched set as a ROOT:
--
--     (comment) => !comment.parentCommentId || !byId.has(comment.parentCommentId)
--
-- so soft-deleting a comment that has replies would PROMOTE those replies to
-- top-level in the thread, stripped of the context that made them legible.
-- `tg_comments_soft_delete` therefore cascades the tombstone to direct replies,
-- which recurses through this same trigger to any deeper ones. Termination is
-- guaranteed by the `deleted_at is null` filter on the cascade UPDATE: a row is
-- only ever touched on its null -> not-null transition.
--
-- Two deliberate asymmetries:
--   * A soft-deleted POST does NOT cascade to its comments. Nothing can reach
--     them (the post is invisible to every reader, so the thread cannot be
--     opened), `posts.comment_count` on an invisible post is not rendered
--     anywhere, and keeping the subtree intact is precisely the moderation
--     history that motivated choosing soft delete. Hard delete still cascades
--     it, as it always has.
--   * UN-deleting does NOT un-cascade. Restoring a parent cannot tell which
--     replies were deleted BY THIS CASCADE from which were deleted by their own
--     authors first, and guessing would resurrect content someone chose to
--     remove. Restore is one row at a time, on purpose.
--
-- ===========================================================================
-- 8. GRANTS — the social_16 lesson, applied defensively
-- ===========================================================================
-- social_16 was a whole outage caused by assuming a policy implies a privilege.
-- On `user_profiles` it does not, because social_08 revoked table-level
-- INSERT/UPDATE and re-granted column by column, so every column added after it
-- starts unwritable. So: does the same fence exist on `posts` / `comments`?
--
-- NO. Grepped across every migration in this directory: the only `revoke` on a
-- table are social_08's (`user_profiles`) and social_10's (`public.users`).
-- Neither `posts` nor `comments` has ever been revoked from, so both still carry
-- the blanket privileges Supabase's default-privilege rule attaches at creation
-- — social_10's header states the rule explicitly: "Supabase ships `alter
-- default privileges in schema public grant all on tables to anon, authenticated,
-- service_role`". `authenticated` therefore already holds table-level DELETE and
-- UPDATE on both tables, and the shipped `posts_delete` / `comments_delete`
-- policies have been enforceable all along rather than dead letters.
--
-- The grants below are nonetheless issued explicitly, because that conclusion
-- rests on WHICH ROLE created the tables, and a table created through the
-- dashboard SQL editor under a different role would not have picked the default
-- privileges up. Re-granting a privilege that is already held is a no-op, so
-- this costs nothing and makes the migration self-sufficient instead of
-- inference-dependent. It widens nothing: RLS still decides every row, and these
-- are the same four privileges the tables are already presumed to carry.
--
-- Not done here, flagged for a future migration: `posts` and `comments` have NO
-- column-level fence, so the author-scoped UPDATE policy also lets an author
-- write `like_count`, `comment_count`, `moderation_checked_at`, and — the sharp
-- one — set `content_status` back to `'visible'` on a post the moderation worker
-- marked `'removed'`. Fencing those columns the way social_08 fences
-- `user_profiles` is the right fix, but it is incompatible with a client that
-- soft-deletes by writing `content_status` directly: that combination needs a
-- SECURITY DEFINER `delete_own_post(uuid)` RPC to own the write instead. That is
-- a deliberate, separate piece of work, not a rider on this one.
--
-- ===========================================================================
-- SAFETY
-- ===========================================================================
-- Additive and idempotent. Four grants (no-ops if held), two policies re-created
-- by name with a one-conjunct change, two trigger functions replaced by
-- `create or replace` with bodies otherwise identical to social_07/social_09,
-- and two NEW triggers. No column is added, dropped, or retyped. No row is
-- inserted, updated, or deleted — the counter-reconciliation statements in the
-- footer are SELECTs, and the repair statement beside them is commented out.
-- Transactional: any failure rolls the whole thing back.

begin;

-- ---------------------------------------------------------------------------
-- 1. Privileges (see section 8) — expected to be no-ops; issued so the file
--    does not depend on an inference about Supabase's default-privilege rule.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.posts    to authenticated;
grant select, insert, update, delete on public.comments to authenticated;

-- ---------------------------------------------------------------------------
-- 2. SELECT policies: the author (and an admin) may read their own tombstone
--    (see section 6). Every other reader's condition is unchanged from social_01.
-- ---------------------------------------------------------------------------
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated using (
  author_id = auth.uid()
  or public.is_admin()
  or (
    deleted_at is null
    and content_status = 'visible'
    and not public.is_blocked(auth.uid(), author_id)
  )
);

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated using (
  author_id = auth.uid()
  or public.is_admin()
  or (
    deleted_at is null
    and content_status = 'visible'
    and not public.is_blocked(auth.uid(), author_id)
  )
);

-- ---------------------------------------------------------------------------
-- 3. Existing counter triggers: don't decrement twice.
--    Bodies are social_07 / social_09 verbatim apart from the `deleted_at`
--    guards, and both keep `security definer set search_path` for the reason
--    those two migrations document (the write targets a row the acting user
--    does not own, and RLS drops it silently otherwise).
--
--    INSERT is guarded too, so a row that somehow arrives already tombstoned is
--    never counted. In practice `deleted_at` is null on insert, so this changes
--    nothing today; it keeps the two branches describing the same rule.
-- ---------------------------------------------------------------------------
create or replace function public.tg_posts_author_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      update public.user_profiles set post_count = post_count + 1 where user_id = new.author_id;
    end if;
  elsif tg_op = 'DELETE' then
    -- Only if it was still counted. A hard delete of an already soft-deleted
    -- post must not decrement a second time.
    if old.deleted_at is null then
      update public.user_profiles set post_count = greatest(post_count - 1, 0) where user_id = old.author_id;
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.tg_comments_post_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      update public.posts set comment_count = comment_count + 1 where id = new.post_id;
    end if;
  elsif tg_op = 'DELETE' then
    if old.deleted_at is null then
      update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
    end if;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. NEW: the soft-delete transition (see section 4).
--    `security definer` for the same reason as above — decrementing the author's
--    `post_count` when an ADMIN soft-deletes someone else's post writes a
--    `user_profiles` row the acting user does not own, and social_08's self-only
--    UPDATE policy would discard that write without raising.
-- ---------------------------------------------------------------------------
create or replace function public.tg_posts_soft_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.user_profiles set post_count = greatest(post_count - 1, 0) where user_id = new.author_id;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.user_profiles set post_count = post_count + 1 where user_id = new.author_id;
  end if;
  return null;
end;
$$;

drop trigger if exists posts_soft_delete_count on public.posts;
create trigger posts_soft_delete_count
  after update on public.posts
  for each row
  when (old.deleted_at is distinct from new.deleted_at)
  execute function public.tg_posts_soft_delete();

-- Comments: same counter transition, plus the reply cascade from section 7.
create or replace function public.tg_comments_soft_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = new.post_id;

    -- Match what `on delete cascade` does on the hard path, so a soft-deleted
    -- comment does not promote its replies to top level in the sheet. Recurses
    -- through this trigger; `deleted_at is null` is what terminates it.
    update public.comments
       set deleted_at     = new.deleted_at,
           content_status = 'deleted'
     where parent_comment_id = new.id
       and deleted_at is null;

  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
    -- Restore does NOT un-cascade; see section 7.
  end if;
  return null;
end;
$$;

drop trigger if exists comments_soft_delete_count on public.comments;
create trigger comments_soft_delete_count
  after update on public.comments
  for each row
  when (old.deleted_at is distinct from new.deleted_at)
  execute function public.tg_comments_soft_delete();

commit;

-- ===========================================================================
-- VERIFY AFTER APPLYING
-- ===========================================================================
--
-- 1. Privileges. All four must be true (section 8 — expected true even before
--    this migration; false here would have meant delete was never possible).
--
--      select has_table_privilege('authenticated', 'public.posts',    'DELETE') as posts_delete,
--             has_table_privilege('authenticated', 'public.posts',    'UPDATE') as posts_update,
--             has_table_privilege('authenticated', 'public.comments', 'DELETE') as comments_delete,
--             has_table_privilege('authenticated', 'public.comments', 'UPDATE') as comments_update;
--
--    And confirm NO column-level fence snuck in (this must return zero rows —
--    a non-empty result means someone revoked table-level rights and the
--    social_16 failure mode is live on these tables):
--
--      select table_name, column_name, privilege_type
--        from information_schema.column_privileges
--       where table_schema = 'public'
--         and table_name in ('posts', 'comments')
--         and grantee = 'authenticated'
--         and privilege_type in ('INSERT', 'UPDATE')
--         and not has_table_privilege('authenticated', 'public.' || table_name, privilege_type);
--
-- 2. Policies. Expect the two shipped delete policies and the two re-created
--    select policies, alongside social_01's insert/update ones:
--
--      select tablename, policyname, cmd, qual
--        from pg_policies
--       where schemaname = 'public'
--         and tablename in ('posts', 'comments')
--       order by tablename, cmd, policyname;
--
--    `posts_delete` / `comments_delete` must both read
--    `(author_id = auth.uid()) OR is_admin()`, and `posts_select` /
--    `comments_select` must now start with `author_id = auth.uid()` rather than
--    `deleted_at IS NULL`.
--
-- 3. Triggers. Expect FOUR rows — the two originals still INSERT/DELETE, and the
--    two new ones on UPDATE:
--
--      select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid)
--        from pg_trigger t
--        join pg_class c on c.oid = t.tgrelid
--       where not t.tgisinternal
--         and c.relname in ('posts', 'comments')
--         and t.tgname in ('posts_author_count', 'comments_post_count',
--                          'posts_soft_delete_count', 'comments_soft_delete_count')
--       order by c.relname, t.tgname;
--
--    Both new definitions must contain `WHEN ((old.deleted_at IS DISTINCT FROM
--    new.deleted_at))`. Without the WHEN clause they would fire on every like.
--
-- 4. All four counter/cascade functions are SECURITY DEFINER with a pinned
--    search_path (`prosecdef` true, `proconfig` non-null on all four rows):
--
--      select proname, prosecdef, proconfig
--        from pg_proc
--       where pronamespace = 'public'::regnamespace
--         and proname in ('tg_posts_author_count', 'tg_comments_post_count',
--                         'tg_posts_soft_delete', 'tg_comments_soft_delete')
--       order by proname;
--
-- 5. Cascades unchanged and complete (expect all seven rows from section 3,
--    every one `delete_rule = 'CASCADE'`):
--
--      select tc.table_name, kcu.column_name, ccu.table_name as references_table, rc.delete_rule
--        from information_schema.table_constraints tc
--        join information_schema.key_column_usage kcu
--          on kcu.constraint_name = tc.constraint_name
--        join information_schema.constraint_column_usage ccu
--          on ccu.constraint_name = tc.constraint_name
--        join information_schema.referential_constraints rc
--          on rc.constraint_name = tc.constraint_name
--       where tc.constraint_type = 'FOREIGN KEY'
--         and tc.table_schema = 'public'
--         and ccu.table_name in ('posts', 'comments')
--       order by tc.table_name, kcu.column_name;
--
-- 6. Counter reconciliation. Both queries should return ZERO rows. Run them
--    BEFORE flipping `USE_SOFT_DELETE`, to confirm the counters start clean, and
--    again a day after, to confirm they stayed that way.
--
--      -- profiles whose post_count disagrees with their live posts
--      select p.user_id, p.post_count as stored, coalesce(a.n, 0) as actual
--        from public.user_profiles p
--        left join (
--          select author_id, count(*) as n
--            from public.posts
--           where deleted_at is null
--           group by author_id
--        ) a on a.author_id = p.user_id
--       where p.post_count is distinct from coalesce(a.n, 0);
--
--      -- posts whose comment_count disagrees with their live comments
--      select po.id, po.comment_count as stored, coalesce(c.n, 0) as actual
--        from public.posts po
--        left join (
--          select post_id, count(*) as n
--            from public.comments
--           where deleted_at is null
--           group by post_id
--        ) c on c.post_id = po.id
--       where po.comment_count is distinct from coalesce(c.n, 0);
--
--    If either returns rows, repair with (COMMENTED OUT — read the results
--    first; a mismatch before any soft delete has happened means something else
--    is wrong and overwriting it hides the real bug):
--
--      -- update public.user_profiles p
--      --    set post_count = coalesce((select count(*) from public.posts
--      --                                where author_id = p.user_id and deleted_at is null), 0);
--      -- update public.posts po
--      --    set comment_count = coalesce((select count(*) from public.comments
--      --                                   where post_id = po.id and deleted_at is null), 0);
--
-- 7. End-to-end smoke test, as a real signed-in user (NOT service_role — it has
--    BYPASSRLS and proves nothing):
--
--      a. Note your post_count. Create a post, comment on it from a SECOND
--         account, then soft-delete the post from the first:
--           update public.posts
--              set deleted_at = now(), content_status = 'deleted'
--            where id = '<post id>'
--            returning id;                     -- must return the row, not empty
--         post_count drops by exactly 1; the post leaves every feed; the second
--         account's `notifications` row still exists.
--      b. Restore it (`set deleted_at = null, content_status = 'visible'`).
--         post_count returns to its original value — not one higher.
--      c. Reply to a comment, then soft-delete the PARENT comment. The reply
--         must come back soft-deleted too, and `posts.comment_count` must drop
--         by 2, not 1.
--      d. From the second account, attempt `delete from public.posts where id =
--         '<first account's post id>'`. It must affect ZERO rows — silently,
--         which is why the client checks the RETURNING set.
--      e. Hard-delete an already soft-deleted post. post_count must NOT move
--         (it was already decremented in step a).
