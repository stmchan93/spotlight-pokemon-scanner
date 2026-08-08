-- Social layer — part 17: let an author delete their OWN posts and comments as a
-- SOFT delete, make the counters survive it, make a deleted comment that has
-- replies become a readable TOMBSTONE instead of taking other people's replies
-- down with it, and redact the tombstone's text server-side so a deleted comment
-- stops being served to other people's devices.
--
-- NOT YET APPLIED anywhere. Apply to staging first, then production.
--
-- ===========================================================================
-- WHAT WAS ALREADY TRUE (read this before assuming this file adds the feature)
-- ===========================================================================
-- The headline ask — "an author may delete their own content, nobody else's" —
-- was ALREADY authorized when social_01 created the tables. This file does not
-- create that permission. It closes the things around it that were not true,
-- and picks the delete SHAPE the client is being written against.
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
--      though, which is exactly the hole section 4 below fills.
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
--      Nothing needed adding, so this file adds no constraint. Note the third
--      one — `comments.parent_comment_id ... cascade` — because section 7 is
--      entirely about NOT reproducing it on the soft path. Two things that are
--      NOT covered, and cannot be fixed with an FK, are called out under "WHY
--      SOFT" below: `reports.target_id` / `moderation_actions.target_id` (bare
--      uuids, deliberately no FK) and the Storage objects behind
--      `post_media.storage_path` (a different subsystem entirely — deleting the
--      metadata row does not delete the image in the bucket).
--
-- ===========================================================================
-- 4. THE FIRST BUG THIS FILE FIXES: counters do not survive a SOFT delete
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
-- WHAT A TOMBSTONE COUNTS AS: nothing. Section 7 makes a deleted comment that
-- has replies stay READABLE, but it is still deleted, and `comment_count` must
-- not count it — a tombstone is not a comment anybody wrote. So the decrement
-- fires on the `deleted_at` transition alone and asks nothing about replies. The
-- replies themselves are untouched and stay counted, because they are still real
-- comments by real people. "3 comments" on a thread showing `[deleted]` plus
-- three live replies is the correct reading of that number, not an off-by-one.
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
--     Hard delete, by contrast, throws that existing machinery away. (Section
--     10 is the one place this stops being free: `fetchComments` must now
--     LOOSEN its filter, not add one.)
--
--   * HARD DELETE DESTROYS OTHER PEOPLE'S REPLIES. `comments.parent_comment_id`
--     is `on delete cascade`, so deleting one comment deletes the entire subtree
--     under it — including replies written by other users, who never consented
--     to that and get no notice. This is the single strongest argument for soft
--     delete and it is what section 7 exists to fix.
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
--     and is NOT in this file. When it runs, hard-deleting a TOMBSTONE will
--     cascade away the replies that were being kept readable underneath it, so
--     that job must re-parent or skip tombstones with live replies. Flagged, not
--     solved here.
--   * `content_status = 'deleted'` is advisory only, for the reason in section 4
--     (the moderation worker can overwrite it). `deleted_at is not null` is the
--     authoritative "this is gone" signal, it is the one RLS enforces, and it is
--     the one section 7's tombstone rule keys on — so a clobbered sentinel still
--     hides the row.
--   * A tombstone row is returned to readers who are not the author, so its
--     `body` would be served to every device in the thread. That is closed in
--     section 8 by redacting the column in Postgres and relocating the original
--     to an admin-only table — the two requirements (do not serve the text, do
--     not destroy the evidence) are both satisfiable, but only server-side.
--     What still leaks after that is listed at the end of section 8.
--
-- ===========================================================================
-- 6. THE AUTHOR MUST BE ABLE TO SEE THEIR OWN TOMBSTONE
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
--   * An author can see their own soft-deleted rows. This exists so the
--     RETURNING read works. It has a cosmetic consequence the client has to
--     handle — see section 10 — because the author now also sees their own
--     childless tombstones, which nobody else does.
--   * An admin can see soft-deleted rows. This is the point of soft delete —
--     an admin who cannot read the tombstone gains nothing from keeping it.
--   * EVERY OTHER READER is unchanged except for the one new branch section 7
--     adds to `comments_select`. On `posts` the non-author condition is byte for
--     byte what social_01 shipped: `deleted_at is null and content_status =
--     'visible' and not is_blocked(...)`. Deleted content does not become
--     visible to anyone it was not visible to, other than as a bodiless
--     tombstone under the narrow rule below.
--
-- The rest of each policy is copied verbatim from social_01 so the diff stays
-- readable. In particular `auth.uid()` is left un-wrapped rather than promoted
-- to the `(select auth.uid())` InitPlan form social_08 uses — that is a real
-- optimization, but it belongs in a migration whose subject is planner behavior,
-- not in one that is already changing delete semantics.
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
-- 7. TOMBSTONES: deleting a comment must not destroy other people's replies
-- ===========================================================================
-- THE BUG. `comments.parent_comment_id` is `on delete cascade`, so a HARD delete
-- of a parent comment wipes the whole subtree beneath it — every reply, by every
-- other user. An earlier draft of this file reproduced that on the soft path
-- (the soft-delete trigger cascaded `deleted_at` down to replies) on the theory
-- that soft and hard should behave identically. That was the wrong instinct.
-- Matching a destructive behaviour is not a virtue; the cascade is the thing to
-- get away from, and soft delete is the only shape that CAN get away from it.
--
-- THE RULE. Soft-deleting a comment removes THAT COMMENT and nothing else.
--
--   * A deleted comment with NO live replies simply disappears, exactly as
--     before — nobody but its author and an admin can see it.
--   * A deleted comment that HAS at least one live reply stays readable as a
--     TOMBSTONE: the row is returned, its body having been redacted in the
--     database on the way in (section 8), the UI renders `[deleted]` in its
--     place (section 10), and the replies underneath it survive, stay attached,
--     and keep their thread context.
--
-- WHY THE TOMBSTONE HAS TO EXIST AT ALL, rather than just hiding the parent:
-- comments-sheet.tsx promotes a comment whose parent is missing from the fetched
-- set to a top-level ROOT —
--
--     (comment) => !comment.parentCommentId || !byId.has(comment.parentCommentId)
--
-- — so an invisible parent does not quietly nest its replies, it SURFACES them
-- as roots, stripped of the context that made them legible. "I disagree, that
-- printing is worth double" is a reply; as a root it is noise. Hiding the parent
-- and keeping the replies is therefore not a middle option: either the parent is
-- visible as a tombstone, or the replies are effectively vandalised. That is the
-- whole reason the earlier draft cascaded.
--
-- WHERE THE RULE LIVES: IN THE RLS POLICY, NOT IN THE CLIENT'S QUERY.
-- The alternative was to leave `comments_select` hiding every tombstone and have
-- `fetchComments` ask for them back with an `.or(...)` — which is rejected, on
-- two independent grounds:
--
--   1. RLS IS A CEILING; A QUERY IS ONLY A FLOOR. A PostgREST filter can only
--      narrow what RLS already permits. If the policy hides tombstones, no query
--      can retrieve one, so the rule literally cannot be implemented client-side
--      — the permit half MUST be in the policy. Given that, splitting the rule
--      so the policy permits tombstones broadly and the client is trusted to
--      re-hide the childless ones would mean every future reader (a web client,
--      a moderation tool, a notification deep link, a hand-written PostgREST
--      call) sees other people's deleted comments until it remembers to filter.
--      That is the exact failure mode section 4 documents for the counters:
--      a rule that lives only in the caller is a rule that drifts.
--   2. IT IS THE SAME RULE ON BOTH SIDES. "Is this row visible?" is one question
--      and it should have one answer. The policy already owns the other three
--      clauses of that answer (`deleted_at`, `content_status`, `is_blocked`);
--      putting the fourth somewhere else would leave no single place to read the
--      visibility rule off.
--
-- So `comments_select` gains one branch:
--
--     or (deleted_at is not null
--         and not public.is_blocked(auth.uid(), author_id)
--         and public.comment_has_live_reply(comments.id))
--
-- WHY THE HELPER FUNCTION, and why SECURITY DEFINER. The obvious spelling is an
-- inline `exists (select 1 from public.comments r where r.parent_comment_id =
-- comments.id and r.deleted_at is null)`. That does not work: a policy ON
-- `comments` that subqueries `comments` re-enters `comments_select` to evaluate
-- the subquery, and Postgres aborts the whole read with 42P17, "infinite
-- recursion detected in policy for relation comments". Every SELECT on the table
-- would fail — not just deletes, the entire feed. The fix is the mechanism
-- social_00 already uses for `is_admin()` and `is_blocked()`: a SECURITY DEFINER
-- function. It runs as its owner (`postgres`, which owns `comments`), table
-- owners bypass RLS unless `force row level security` is set, so the inner read
-- sees raw rows, applies no policy, and never recurses. `search_path` is pinned
-- for the usual SECURITY DEFINER reason.
--
-- It is not an information leak. The function returns a single boolean —
-- "something is still attached here" — about a row the caller is being shown
-- anyway, and it exposes no reply's author, body, or existence individually. A
-- caller can already infer as much from the replies it can see.
--
-- WHAT COUNTS AS A "LIVE" REPLY: `deleted_at is null`, and nothing else. Not
-- `content_status = 'visible'`, not per-reader block filtering. Same reasoning
-- as the counters in section 4 — `deleted_at` is the monotonic signal owned by
-- this path — plus a practical one: evaluating blocks inside the helper would
-- make it per-reader, uncacheable, and run on every comment row of every thread.
-- The cosmetic worst case is an empty-looking tombstone for a reader who has
-- blocked every replier, or whose only reply was moderation-removed. That reader
-- sees one `[deleted]` line with nothing under it. Acceptable.
--
-- DIRECT REPLIES ONLY, one level, not the whole descendant tree. Chain A -> B ->
-- C where the author deletes both A and B: B has a live reply (C) so B survives
-- as a tombstone; A's only child B is deleted, so A does not, and B is promoted
-- to root by the sheet's existing rule. The thread reads as `[deleted]` with C
-- under it — the surviving content stays grouped and in order, which is the
-- goal. Making A survive too would need a recursive descendant walk per row in
-- an RLS qual, which is a real cost for a case that already degrades gracefully.
--
-- THE RULE IS EVALUATED AT READ TIME, not materialized into a column, and that
-- is deliberate: when the last live reply under a tombstone is itself deleted,
-- the tombstone stops matching and disappears on the very next read, with no
-- trigger, no backfill, and no flag to get out of sync. The same holds in
-- reverse — a new reply to a tombstone (should the UI ever allow it) brings it
-- back. There is no state to maintain.
--
-- INDEX. `comments` has had NO index on `parent_comment_id` since social_01
-- (only `idx_comments_post` and `idx_comments_unchecked`), so the helper's
-- lookup would be a sequential scan, and — separately and already true today —
-- so is the FK cascade check Postgres runs on EVERY comment hard-delete. One
-- partial index fixes both. It is partial on `parent_comment_id is not null`
-- because most comments are top-level and those rows are dead weight in it; the
-- planner can still use it for the FK's `parent_comment_id = $1` probe, since
-- that predicate implies the index's. Built non-CONCURRENTLY because this whole
-- file is one transaction and the table is small; on a large `comments` table
-- this would need to move to its own migration.
--
-- POSTS GET NO TOMBSTONE. A post has no parent chain and nothing is orphaned by
-- hiding it, so a soft-deleted post stays invisible to everyone but its author
-- and an admin — the social_01 behaviour, unchanged. Its comments are left
-- alone too: nothing can reach them (the post is invisible, so the thread cannot
-- be opened), and keeping the subtree intact is precisely the moderation history
-- that motivated choosing soft delete.
--
-- UN-DELETING is one row at a time, on purpose. Restoring a comment restores
-- that comment. Since nothing cascades on the way down, there is nothing to
-- un-cascade on the way back up — which is a second, quieter benefit of dropping
-- the cascade: restore is now exactly symmetric with delete, where before it
-- could not be (a restore cannot tell which replies were deleted BY the cascade
-- from which their own authors deleted first, and guessing would resurrect
-- content someone chose to remove).
--
-- ===========================================================================
-- 8. REDACTING THE BODY — a tombstone must not ship the deleted text
-- ===========================================================================
-- THE PROBLEM SECTION 7 CREATES. Before this migration, a soft-deleted comment
-- was invisible to everyone, so its `body` went nowhere. A tombstone is
-- deliberately visible, and RLS grants or denies WHOLE ROWS — it cannot blank a
-- column. So the moment `comments_select` starts returning tombstones, the
-- deleted text starts being served to every device in the thread.
--
-- Dropping `body` at the client's mapping boundary does NOT fix this. By the
-- time the client discards it, the bytes have already crossed the wire, and the
-- anon key that authorises the read SHIPS IN THE APP BUNDLE — anyone can replay
-- the same PostgREST request by hand and read the column directly. A redaction
-- that the reader performs on themselves is not a redaction. If the text is
-- supposed to be gone, it has to stop leaving Postgres.
--
-- THE TENSION, WHICH IS REAL. Blanking the column destroys precisely what
-- section 5 says soft delete exists to preserve: the evidence behind an open
-- `reports` row. Losing it would hand back the "delete it before the moderator
-- looks" hole that hard delete was rejected for. So the answer is not to destroy
-- the text — it is to RELOCATE it somewhere the anon key cannot reach:
--
--     public.deleted_content_bodies (target_type, target_id, body, archived_at)
--
-- RLS enabled with NO policies, and `revoke all ... from anon, authenticated`.
-- Two independent fences, either of which alone would be sufficient: even if a
-- future `grant` re-appears, no policy means no row is visible; even if a policy
-- appears, the revoke means no privilege. `service_role` (the backend, the
-- moderation worker, the SQL editor) still reads it normally.
--
-- WHY A SEPARATE TABLE, not a column-level SELECT fence on `comments`. Hiding
-- `comments.body` from `authenticated` in place would mean `revoke select on
-- public.comments from authenticated` followed by re-granting every other column
-- by name — the social_08 shape, whose consequence social_16 documents as an
-- outage: every column added to that table afterwards silently starts
-- unreadable, and nothing tells you. Section 9 below establishes that `posts`
-- and `comments` carry no such fence and argues that is a good thing; adding one
-- here would contradict it for a narrow gain. A separate table gets the same
-- protection with none of that blast radius. It also does something a column
-- cannot: it OUTLIVES THE ROW. A later hard delete (the retention job) takes the
-- comment and leaves the evidence standing.
--
-- NO FOREIGN KEY on `target_id`, deliberately, and for the same reason social_04
-- leaves `reports.target_id` bare: one column addresses more than one target
-- type. Here it is also load-bearing rather than incidental — an FK with any
-- action would let a hard delete reach the archive, which is the one thing the
-- archive must survive.
--
-- MECHANICS: BEFORE UPDATE, not AFTER. The redaction triggers use the same
-- `when (old.deleted_at is distinct from new.deleted_at)` guard as the counters
-- (section 4 — `posts` is UPDATEd on every like), but fire BEFORE the row is
-- written so they can assign `new.body` in place. That matters three ways: no
-- second UPDATE against the same row, so no re-entrancy to reason about; one
-- write instead of two; and the redaction is ATOMIC WITH THE DELETE, so there is
-- no instant at which a concurrent reader can observe a tombstone that still has
-- its body in it.
--
-- `comments.body` is `text not null` (social_01), so the redacted value is the
-- empty string, not null. Nothing keys off it — `deleted_at` is what tells the
-- client this is a tombstone (section 10) — so the exact value is not
-- load-bearing, only its emptiness is.
--
-- SECURITY DEFINER is REQUIRED here, not defensive. The archive table revokes
-- everything from `authenticated`, so a trigger running as the invoking user
-- could not INSERT into it, and the failure would not be silent the way social_09
-- describes — it would raise 42501 and abort the user's delete outright. Running
-- as the owner is what makes the write possible at all.
--
-- RESTORE PUTS IT BACK. The not-null -> null branch reads the archived body,
-- restores it to the row, and deletes the archive row. Without that half,
-- blanking would quietly make soft delete IRREVERSIBLE, which would defeat the
-- point of choosing it. The archive's primary key is `(target_type, target_id)`
-- and the insert is `on conflict ... do update`, so a delete/restore/delete cycle
-- keeps working rather than colliding on the second pass.
--
-- POSTS ARE NOT REDACTED, and that is a decision, not an omission. `posts_select`
-- has no tombstone branch (section 7) — a post has no reply tree to orphan — so
-- a soft-deleted post still fails the public branch's `deleted_at is null` and
-- its body never reaches any reader but its author and an admin. There is no
-- exposure to close. Redacting anyway would relocate evidence for no benefit and
-- put an extra trigger on the app's hottest write table. If `posts` ever grows a
-- tombstone branch, this must be revisited in the SAME change that adds it —
-- which is why `deleted_content_bodies.target_type` already accepts `'post'`.
--
-- WHAT STILL LEAKS, stated honestly. The tombstone row is still a row: it
-- carries `author_id`, `created_at`, `like_count`, `parent_comment_id`. WHO
-- wrote the deleted comment and WHEN remain readable to anyone querying
-- directly — and the sheet already tells repliers as much, since a reply's
-- @mention is the handle of its parent's author. The body was the part worth
-- closing and it is closed; the metadata residue needs the same view-or-RPC
-- read path floated in section 5, which would project a tombstone down to
-- `{id, parent_comment_id, deleted}` and nothing else. Separate work, flagged.
--
-- TWO SIDE EFFECTS WORTH KNOWING. (a) The moderation worker reads `body`; a
-- comment soft-deleted before its first worker pass will be scanned as blank and
-- marked checked. Harmless, since the row is already hidden — but it means the
-- worker is not where a deleted comment's text lives any more.
-- `deleted_content_bodies` is. (b) The archive is unbounded and survives hard
-- delete, so the retention job in section 5 owns purging it too, and any
-- right-to-erasure procedure must name it explicitly or it will miss the one
-- table that still holds the words.
--
-- ===========================================================================
-- 9. GRANTS — the social_16 lesson, applied defensively
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
-- are the same four privileges the tables are already presumed to carry. The
-- `grant execute` on the new helper is the same kind of no-op — functions grant
-- EXECUTE to PUBLIC by default, and `is_admin()` / `is_blocked()` have relied on
-- that since social_00 — written out so this file does not depend on it either.
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
-- 10. WHAT THE CLIENT MUST DO DIFFERENTLY (no TypeScript ships in this file)
-- ===========================================================================
-- This migration is safe to apply BEFORE any client change: with
-- `USE_SOFT_DELETE = false` the app keeps hard-deleting and nothing below
-- applies. Everything here is what flipping that constant requires.
--
--   a. `deleteOwnedRow` flips `USE_SOFT_DELETE` to true. Its `.select('id')`
--      contract is unchanged and still works, which is what section 6 buys.
--
--   b. `fetchComments` must DROP `.is('deleted_at', null)` and
--      `.neq('content_status', 'deleted')`. Those filters are now actively
--      wrong: they would discard the tombstone the policy just went to the
--      trouble of returning, and the sheet would promote its replies to root —
--      the exact bug section 7 fixes. RLS is now the authority on which comment
--      rows exist; the query must stop second-guessing it. (`fetchPosts` keeps
--      both filters — posts have no tombstones, so nothing changed there.)
--
--   c. `fetchComments` must instead drop, IN MEMORY, any returned row where
--      `deleted_at != null` AND no other row in the fetched set has
--      `parent_comment_id == row.id && deleted_at == null`. That predicate is
--      deliberately the SAME ONE the policy applies (`comment_has_live_reply`),
--      so the two agree by construction and the prune is a fixed point: on rows
--      RLS returned to a non-author it is always a no-op, because RLS already
--      proved a live reply exists.
--
--      It is not a re-litigation of the RLS rule. It exists for the one case RLS
--      deliberately permits and the UI does not want — section 6's author
--      relaxation, which shows an author (and an admin) every one of their own
--      tombstones including childless ones. Without this pass, deleting your own
--      childless comment leaves `[deleted]` on screen and reads as a failed
--      delete.
--
--      Two places the client is STRICTLY NARROWER than the policy, both benign:
--      a reply hidden from this reader by a block or by `content_status` is not
--      in the fetched set, so the client prunes a tombstone the policy would
--      have shown — and since that reader cannot see the reply either, no reply
--      is orphaned. Same for a reply cut off by the `limit`: comments come back
--      oldest-first, so a truncated page drops the tombstone and its replies
--      together, never the parent alone.
--
--   d. `PostComment` needs a deleted flag (e.g. `isDeleted`, from
--      `deleted_at != null`) and the row renderer needs a `[deleted]` state:
--      no body, no author name, no like button, no reply button, no delete
--      action. The flag must come from `deleted_at`, NOT from an empty body —
--      section 8 redacts the column to `''` in the database, so a tombstone's
--      body arrives blank, but blankness is a consequence of the delete and not
--      the signal for it. Also drop the @mention on a reply whose direct parent
--      is a tombstone: `mentionHandleOf` in comments-sheet.tsx would otherwise
--      name the deleted comment's author right where the UI is trying to say
--      the comment is gone.
--
--   e. `collectDescendantIds` in comments-sheet.tsx is now WRONG for the soft
--      path and its doc comment is stale ("`parent_comment_id` is `on delete
--      cascade`, so deleting a comment takes its whole subtree with it"). Under
--      soft delete nothing is taken. The sheet must stop removing descendants
--      optimistically — it should mark the one comment deleted and leave its
--      replies in place — and the delete confirmation must stop saying "This
--      also deletes the N replies underneath it. This can't be undone." The
--      replies survive; say so, or say nothing. Note the function is still
--      correct for the HARD path, so it should be kept, not deleted, until
--      `USE_SOFT_DELETE` is permanent.
--
--   f. `comment_count` on the post drops by exactly 1 per deleted comment, never
--      by the subtree size (section 4). Any optimistic count adjustment in the
--      sheet that subtracts `1 + descendants.length` must become `1`.
--
-- ===========================================================================
-- SAFETY
-- ===========================================================================
-- Additive and idempotent. Five grants (no-ops if held), one NEW empty table
-- (`deleted_content_bodies`, revoked from the client roles), one new helper
-- function, one new partial index, two policies re-created by name, two trigger
-- functions replaced by `create or replace` with bodies otherwise identical to
-- social_07/social_09, and FOUR new triggers (two AFTER for the counters, two
-- BEFORE for the redaction). No column on an existing table is added, dropped,
-- or retyped. No existing row is inserted, updated, or deleted — the
-- counter-reconciliation statements in the footer are SELECTs, and the repair
-- statement beside them is commented out. Transactional: any failure rolls the
-- whole thing back.
--
-- The index build takes a brief ACCESS EXCLUSIVE lock on `comments`. That is
-- fine at current size; re-check before applying to a `comments` table large
-- enough for the build to be measurable.
--
-- The redaction triggers are the only part that is not trivially reversible in
-- effect: once a comment has been soft-deleted its body lives in
-- `deleted_content_bodies` rather than in the row. Restore moves it back, so
-- nothing is lost, but a rollback of THIS MIGRATION after soft deletes have
-- happened would leave those bodies stranded in the archive. Reverting therefore
-- means dropping the triggers and copying the archive back into the rows, not
-- just dropping the table. Do not drop `deleted_content_bodies` casually.

begin;

-- ---------------------------------------------------------------------------
-- 1. Privileges (see section 9) — expected to be no-ops; issued so the file
--    does not depend on an inference about Supabase's default-privilege rule.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.posts    to authenticated;
grant select, insert, update, delete on public.comments to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tombstone support: the index, then the helper (see section 7).
--
--    The index serves two readers: this helper, and the FK cascade check
--    Postgres already runs on every `comments` hard-delete (which has been a
--    sequential scan since social_01). Partial on `parent_comment_id is not
--    null` — top-level comments are the majority and are never probed by
--    either reader, and `parent_comment_id = $1` implies the predicate, so the
--    planner can still use it.
-- ---------------------------------------------------------------------------
create index if not exists idx_comments_parent
  on public.comments (parent_comment_id)
  where parent_comment_id is not null;

-- comment_has_live_reply(): does this comment still have at least one reply that
-- has not itself been deleted?
--
-- SECURITY DEFINER is REQUIRED, not stylistic. `comments_select` calls this, and
-- an inline subquery over `comments` inside a policy on `comments` re-enters
-- that same policy and fails every read on the table with 42P17 ("infinite
-- recursion detected in policy for relation comments"). Running as the owner
-- (which bypasses RLS, as `comments` is not FORCE ROW LEVEL SECURITY) breaks the
-- cycle. Same mechanism social_00 uses for is_admin() / is_blocked().
--
-- `stable`: reads only, no writes, consistent within a statement — lets the
-- planner cache the call per row and hoist it where it can.
--
-- Liveness is `deleted_at is null` ONLY. Deliberately not `content_status` and
-- deliberately not block-aware; see section 7.
create or replace function public.comment_has_live_reply(comment_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.comments r
     where r.parent_comment_id = comment_id
       and r.deleted_at is null
  );
$$;

grant execute on function public.comment_has_live_reply(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. SELECT policies.
--
--    posts: author/admin may read their own tombstone (section 6). Every other
--    reader's condition is byte-for-byte social_01's.
--
--    comments: the same relaxation, PLUS the tombstone branch (section 7).
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
  -- The author of the comment, and any admin, see it in every state. This is
  -- what makes the soft delete's own `... returning id` come back non-empty.
  author_id = auth.uid()
  or public.is_admin()
  -- The unchanged public rule: live, not moderation-hidden, not blocked.
  or (
    deleted_at is null
    and content_status = 'visible'
    and not public.is_blocked(auth.uid(), author_id)
  )
  -- TOMBSTONE. A deleted comment stays readable to everyone ONLY while at least
  -- one live reply hangs off it, so those replies keep their parent and are not
  -- promoted to top level by the sheet. `content_status` is intentionally not
  -- checked: the branch keys on `deleted_at` alone, so a moderation-`removed`
  -- comment (which never sets `deleted_at`) is NOT resurrected by it. Blocks are
  -- honoured exactly as on the public branch, so blocking behaves identically
  -- for a tombstone and for a live comment.
  or (
    deleted_at is not null
    and not public.is_blocked(auth.uid(), author_id)
    and public.comment_has_live_reply(comments.id)
  )
);

-- ---------------------------------------------------------------------------
-- 4. Existing counter triggers: don't decrement twice.
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

-- Note for the hard path: deleting a comment still cascades to its replies via
-- `comments.parent_comment_id`, and this trigger fires once per cascaded row.
-- Each one decrements only if it was still live, so a subtree containing
-- tombstones decrements by the number of LIVE comments in it, not by its size.
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
-- 5. NEW: the soft-delete transition (see section 4).
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

-- Comments: the counter transition and NOTHING ELSE.
--
-- This function used to also cascade `deleted_at` down to the comment's replies,
-- mirroring the `on delete cascade` on the hard path. That is removed on
-- purpose (section 7): a soft delete now touches exactly one row, other people's
-- replies survive, and the parent stays readable as a tombstone via
-- `comments_select`. One consequence worth naming — with the cascade gone this
-- trigger no longer writes to `public.comments`, so it cannot re-enter itself
-- and there is no recursion to reason about at all.
--
-- The decrement is unconditional on the transition. A comment that remains
-- visible AS A TOMBSTONE still decrements: it is deleted, it is not a comment
-- anyone wrote, and `comment_count` must not count it. Its replies are not
-- touched here and stay counted, because they are still real comments.
create or replace function public.tg_comments_soft_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = new.post_id;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
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

-- ---------------------------------------------------------------------------
-- 6. NEW: body redaction (see section 8).
--
--    A tombstone is returned to readers who are not its author, so its text has
--    to leave the row. It must NOT be destroyed — it is the evidence behind any
--    open report — so it is relocated to a table the anon key cannot reach.
-- ---------------------------------------------------------------------------
create table if not exists public.deleted_content_bodies (
  -- `(target_type, target_id)` is deliberately the SAME addressing shape as
  -- `reports` and `moderation_actions` (social_04, `post | comment | message |
  -- profile`), so a moderator holding a report can join straight to the text
  -- that was deleted out from under it. `'message'` is not accepted yet —
  -- DM soft delete is its own path and is not in scope here; widening the check
  -- constraint is the one-line change if that lands.
  --
  -- No FK on target_id, on purpose: one column addresses more than one target
  -- type (the same reason social_04 leaves `reports.target_id` bare), and — the
  -- part that matters here — the archive must SURVIVE a later hard delete of the
  -- row it describes. Any FK action would defeat that.
  target_type text        not null check (target_type in ('post', 'comment')),
  target_id   uuid        not null,
  body        text,
  archived_at timestamptz not null default now(),
  primary key (target_type, target_id)
);

-- The revoke is REQUIRED, not belt-and-braces: Supabase's `alter default
-- privileges ... grant all on tables to anon, authenticated, service_role`
-- (section 9) means this table is born fully granted to the app's roles, so a
-- table created and left alone would be readable with the anon key that ships in
-- the bundle. Two independent fences after it: RLS with NO policies means no row
-- is selectable even if a grant reappears; the revoke means no privilege even if
-- a policy appears. `service_role` keeps its access, so the backend and the
-- moderation queue read this normally. `'post'` is accepted by the check
-- constraint but nothing writes it today — posts are not redacted (section 8) —
-- so the table does not need altering if that ever changes.
alter table public.deleted_content_bodies enable row level security;
revoke all on public.deleted_content_bodies from anon, authenticated;

-- BEFORE UPDATE, not AFTER: assigning `new.body` in place means one write, no
-- re-entrancy, and no instant in which a concurrent reader can see a tombstone
-- that still carries its text.
--
-- SECURITY DEFINER is REQUIRED, not defensive. The archive is revoked from
-- `authenticated`, so running as the invoking user would raise 42501 and abort
-- the user's own delete.
--
-- `comments.body` is `text not null` (social_01), so the redacted value is `''`.
-- The client keys the tombstone off `deleted_at`, never off an empty body.
create or replace function public.tg_comments_redact_body()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  archived_body text;
begin
  if old.deleted_at is null and new.deleted_at is not null then
    -- `on conflict` so a delete -> restore -> delete cycle keeps working.
    insert into public.deleted_content_bodies (target_type, target_id, body)
    values ('comment', old.id, old.body)
    on conflict (target_type, target_id) do update
      set body = excluded.body, archived_at = now();
    new.body := '';

  elsif old.deleted_at is not null and new.deleted_at is null then
    -- Restore. Without this half, blanking would make soft delete irreversible.
    select b.body into archived_body
      from public.deleted_content_bodies b
     where b.target_type = 'comment'
       and b.target_id = old.id;
    if archived_body is not null then
      new.body := archived_body;
      delete from public.deleted_content_bodies
       where target_type = 'comment'
         and target_id = old.id;
    end if;
    -- No archive row (e.g. a row soft-deleted before this migration landed):
    -- leave `new.body` exactly as the caller set it rather than blanking it.
  end if;
  return new;
end;
$$;

-- Same WHEN guard as the counter triggers, for the same reason (section 4).
drop trigger if exists comments_redact_body on public.comments;
create trigger comments_redact_body
  before update on public.comments
  for each row
  when (old.deleted_at is distinct from new.deleted_at)
  execute function public.tg_comments_redact_body();

-- NOTE: there is deliberately no `posts_redact_body`. `posts_select` has no
-- tombstone branch, so a soft-deleted post's body never reaches a reader who is
-- not its author or an admin — there is no exposure to close, and adding a
-- trigger to the app's hottest write table to close nothing is not free. If
-- `posts` ever gains a tombstone branch, add the mirror of the above in the SAME
-- migration that adds it.

commit;

-- ===========================================================================
-- VERIFY AFTER APPLYING
-- ===========================================================================
--
-- 1. Privileges. All four must be true (section 9 — expected true even before
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
-- 2. The tombstone helper exists, is SECURITY DEFINER, is owned by a role that
--    bypasses RLS on `comments`, and is executable by `authenticated`. All four
--    matter: an owner that does NOT own `comments` turns every comment read
--    into a 42P17 recursion error, and a missing EXECUTE turns it into a
--    permission-denied on the policy.
--
--      select p.proname,
--             p.prosecdef                         as security_definer,   -- must be true
--             p.proconfig                         as pinned_search_path, -- must be non-null
--             pg_get_userbyid(p.proowner)         as owner,
--             pg_get_userbyid(c.relowner)         as comments_owner,     -- must MATCH owner
--             c.relrowsecurity                    as rls_enabled,        -- true
--             c.relforcerowsecurity               as rls_forced,         -- must be FALSE
--             has_function_privilege('authenticated',
--               'public.comment_has_live_reply(uuid)', 'EXECUTE') as authenticated_can_call
--        from pg_proc p
--        cross join pg_class c
--       where p.pronamespace = 'public'::regnamespace
--         and p.proname = 'comment_has_live_reply'
--         and c.oid = 'public.comments'::regclass;
--
--    And the index the helper (and the FK cascade) depend on:
--
--      select indexname, indexdef
--        from pg_indexes
--       where schemaname = 'public'
--         and tablename = 'comments'
--         and indexname = 'idx_comments_parent';
--
-- 3. Policies. Expect the two shipped delete policies and the two re-created
--    select policies, alongside social_01's insert/update ones:
--
--      select tablename, policyname, cmd, qual
--        from pg_policies
--       where schemaname = 'public'
--         and tablename in ('posts', 'comments')
--       order by tablename, cmd, policyname;
--
--    `posts_delete` / `comments_delete` must both read
--    `(author_id = auth.uid()) OR is_admin()`. `posts_select` and
--    `comments_select` must both now START with `author_id = auth.uid()` rather
--    than `deleted_at IS NULL`, and `comments_select` ALONE must contain
--    `comment_has_live_reply`. If that call is missing from the qual, the
--    tombstone rule is not in force and soft-deleting a parent will orphan its
--    replies to top level — the exact bug this migration exists to prevent.
--
-- 4. Triggers. Expect FIVE rows — the two originals still INSERT/DELETE, the
--    two new counter triggers on AFTER UPDATE, and the redaction trigger on
--    BEFORE UPDATE:
--
--      select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid)
--        from pg_trigger t
--        join pg_class c on c.oid = t.tgrelid
--       where not t.tgisinternal
--         and c.relname in ('posts', 'comments')
--         and t.tgname in ('posts_author_count', 'comments_post_count',
--                          'posts_soft_delete_count', 'comments_soft_delete_count',
--                          'comments_redact_body')
--       order by c.relname, t.tgname;
--
--    All three new definitions must contain `WHEN ((old.deleted_at IS DISTINCT
--    FROM new.deleted_at))` — without it they would fire on every like — and
--    `comments_redact_body` must say `BEFORE UPDATE`, not AFTER. An AFTER
--    redaction trigger cannot assign `new.body` and would silently do nothing.
--
-- 5. All five trigger functions are SECURITY DEFINER with a pinned search_path
--    (`prosecdef` true, `proconfig` non-null on all five rows), and
--    `tg_comments_soft_delete` no longer cascades:
--
--      select proname, prosecdef, proconfig
--        from pg_proc
--       where pronamespace = 'public'::regnamespace
--         and proname in ('tg_posts_author_count', 'tg_comments_post_count',
--                         'tg_posts_soft_delete', 'tg_comments_soft_delete',
--                         'tg_comments_redact_body')
--       order by proname;
--
--      -- must return FALSE: the reply cascade is gone for good.
--      select prosrc ilike '%parent_comment_id%' as still_cascades
--        from pg_proc
--       where pronamespace = 'public'::regnamespace
--         and proname = 'tg_comments_soft_delete';
--
-- 5b. The redaction archive exists and is unreachable from the app's roles.
--     `rls_enabled` true, `policy_count` 0, and BOTH privilege checks false —
--     any true means a deleted comment's text is readable with the anon key
--     that ships in the app bundle:
--
--      select c.relrowsecurity as rls_enabled,
--             (select count(*) from pg_policies
--               where schemaname = 'public'
--                 and tablename = 'deleted_content_bodies')            as policy_count,
--             has_table_privilege('authenticated',
--               'public.deleted_content_bodies', 'SELECT')             as authenticated_can_read,
--             has_table_privilege('anon',
--               'public.deleted_content_bodies', 'SELECT')             as anon_can_read
--        from pg_class c
--       where c.oid = 'public.deleted_content_bodies'::regclass;
--
-- 6. Cascades unchanged and complete (expect all seven rows from section 3 of
--    the header, every one `delete_rule = 'CASCADE'` — including
--    `comments.parent_comment_id`, which the HARD path still relies on):
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
-- 7. Counter reconciliation. Both queries should return ZERO rows. Run them
--    BEFORE flipping `USE_SOFT_DELETE`, to confirm the counters start clean, and
--    again a day after, to confirm they stayed that way. Note the `deleted_at is
--    null` in the second one: tombstones are NOT counted, which is the rule from
--    section 4 written as a query.
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
-- 8. Tombstone census — a read-only look at what the new policy branch is
--    actually doing on live data. Run as service_role (this is an audit of raw
--    rows, not a permission check):
--
--      select count(*) filter (where deleted_at is not null)                     as tombstoned_total,
--             count(*) filter (where deleted_at is not null
--                                and public.comment_has_live_reply(id))          as visible_as_tombstone,
--             count(*) filter (where deleted_at is not null
--                                and not public.comment_has_live_reply(id))      as fully_hidden
--        from public.comments;
--
--    Before any soft delete has happened all three are 0. Afterwards,
--    `visible_as_tombstone` is the number of `[deleted]` rows users can see, and
--    every one of them should have live replies under it:
--
--      select c.id, c.post_id,
--             (select count(*) from public.comments r
--               where r.parent_comment_id = c.id and r.deleted_at is null) as live_replies
--        from public.comments c
--       where c.deleted_at is not null
--         and public.comment_has_live_reply(c.id);
--
--    `live_replies` must be >= 1 on every row. A 0 would mean the helper and the
--    census disagree, i.e. the helper is not doing what it says.
--
--    And the redaction audit, also as service_role. This must return ZERO rows:
--    a soft-deleted comment that still holds text in its own row is text the
--    tombstone branch is serving to other people's devices.
--
--      select c.id, c.post_id, length(c.body) as leaked_chars
--        from public.comments c
--       where c.deleted_at is not null
--         and coalesce(c.body, '') <> '';
--
--    Conversely, every redacted comment should have its original safely parked.
--    This must also return ZERO rows (rows here mean the archive INSERT failed
--    while the blanking succeeded, i.e. evidence was destroyed, which is the
--    failure mode section 8 exists to prevent):
--
--      select c.id
--        from public.comments c
--       where c.deleted_at is not null
--         and not exists (
--           select 1 from public.deleted_content_bodies b
--            where b.target_type = 'comment' and b.target_id = c.id
--         );
--
-- 9. End-to-end smoke test, as a real signed-in user (NOT service_role — it has
--    BYPASSRLS and proves nothing). Two accounts, called A and B.
--
--      a. POST SOFT DELETE + COUNTER. As A, note post_count. Create a post,
--         comment on it from B, then from A:
--           update public.posts
--              set deleted_at = now(), content_status = 'deleted'
--            where id = '<post id>'
--            returning id;                     -- must return the row, not empty
--         A's post_count drops by exactly 1; the post leaves every feed for both
--         accounts; B's `notifications` row still EXISTS (soft delete does not
--         retract a notification B may already have read).
--
--      b. RESTORE. `set deleted_at = null, content_status = 'visible'`.
--         post_count returns to its original value — not one higher.
--
--      c. TOMBSTONE — THE HEADLINE CASE. On a live post: A writes a comment, B
--         replies to it, C (or B again) replies to the reply. Note the post's
--         comment_count (3). Now A soft-deletes ONLY their own comment:
--           update public.comments
--              set deleted_at = now(), content_status = 'deleted'
--            where id = '<A comment id>'
--            returning id;                     -- must return the row
--         Then, signed in as B, `select id, parent_comment_id, deleted_at from
--         public.comments where post_id = '<post id>' order by created_at`:
--           * B's reply and the deeper reply are STILL THERE, undeleted, with
--             `parent_comment_id` unchanged. If either is missing or deleted,
--             the cascade is still in the trigger and the fix did not land.
--           * A's comment IS returned to B, with `deleted_at` set — the
--             tombstone. If it is missing, B's reply has no parent in the set
--             and the sheet will promote it to a top-level root.
--           * `posts.comment_count` is now 2, NOT 0 and not 3: the tombstone
--             stopped counting, the two replies kept counting. (This assertion
--             replaces the earlier draft's "must drop by 2" — that number came
--             from the reply cascade, which no longer exists.)
--           * A's comment comes back to B with `body = ''`. If B can read the
--             original text, the redaction trigger did not fire — check it is
--             BEFORE UPDATE, not AFTER (footer item 4).
--
--      c2. REDACTION IS A RELOCATION, NOT A LOSS. As service_role:
--            select body from public.deleted_content_bodies
--             where target_type = 'comment' and target_id = '<A comment id>';
--          must return A's original text. Then, as B (an ordinary signed-in
--          user), `select * from public.deleted_content_bodies;` must FAIL with
--          42501 (permission denied) — not return zero rows, which would mean
--          the privilege is still there and only RLS is holding the line.
--          Finally, as A, restore the comment (`set deleted_at = null,
--          content_status = 'visible'`): the body must reappear in the row,
--          comment_count returns to 3, and the archive row must be GONE.
--
--      d. CHILDLESS TOMBSTONE STAYS HIDDEN. As B, soft-delete B's own reply, and
--         the deeper reply too, so nothing live hangs off A's comment any more.
--         Then as B (and from a third account with no involvement) re-run the
--         select from (c): A's tombstone must now be ABSENT — no live reply, no
--         reason to show it. As A, it is still visible (section 6's author
--         relaxation), which is exactly why the client does the in-memory pass
--         in section 10c. comment_count is now 0.
--
--      e. NO CROSS-ACCOUNT DELETE. From B: `delete from public.posts where id =
--         '<A's post id>'`, and `update public.comments set deleted_at = now()
--         where id = '<A's comment id>' returning id`. BOTH must affect ZERO
--         rows — silently, which is why the client checks the RETURNING set.
--
--      f. HARD DELETE STILL WORKS AND DOES NOT DOUBLE-COUNT. Hard-delete an
--         already soft-deleted post: post_count must NOT move (it was already
--         decremented in step a). Hard-delete a live comment that has replies:
--         the replies go with it (the FK cascade, unchanged) and comment_count
--         drops by the number of LIVE rows removed, not by the subtree size.
--
--      g. NO RECURSION. The cheapest check that the SECURITY DEFINER helper is
--         doing its job — as any signed-in user, `select count(*) from
--         public.comments;`. If this raises 42P17 ("infinite recursion detected
--         in policy for relation comments"), the helper is missing, is not
--         SECURITY DEFINER, or is owned by a role that does not own `comments`.
--         Every comment read in the app is broken in that state, so check it
--         first.
