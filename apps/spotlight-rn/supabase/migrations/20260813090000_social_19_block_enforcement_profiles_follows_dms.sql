-- Social layer — part 19: finish enforcing BLOCKS server-side.
--
-- NOT YET APPLIED anywhere. Apply to STAGING first, then production.
--
-- Blocking is the one safety action a user can take on their own, and Apple's
-- reviewers exercise it directly on any app carrying user-generated content. It
-- has to be true end to end, not true on the surfaces we happened to reach
-- first. This file closes the surfaces that were still open after social_13.
--
-- ===========================================================================
-- 0. WHAT IS ALREADY TRUE — do not redo it
-- ===========================================================================
-- `public.is_blocked(a, b)` (social_00) is EITHER-DIRECTION and is already woven
-- into:
--
--   posts_select / comments_select        social_01, re-stated social_17
--   post_media_select                     social_01
--   follows_insert, post_likes_insert     social_00, social_01
--   messages_insert                       social_13, via conversation_has_block()
--   conv_participants_insert              social_13
--   unread_dm_counts()                    social_13
--
-- In particular, social_13 ALREADY fixed "a blocked user can still send you a
-- DM". The comment block in `src/features/social/social-service.ts` that says
-- otherwise predates social_13 and is stale on that one point; it is still
-- correct about `public_profiles` and about `follows` SELECT. Updating that
-- comment is an app change and is not made here.
--
-- ===========================================================================
-- 1. WHAT WAS ACTUALLY STILL OPEN
-- ===========================================================================
-- Four holes, in descending order of how badly they hurt a real user:
--
--   A. `messages_update` (social_02, untouched by social_13) is
--
--        using (sender_id = auth.uid()) with check (sender_id = auth.uid())
--
--      Participation is not even checked, let alone blocks. So a blocked user
--      cannot SEND a new message — and can still EDIT one they already sent.
--      `messages` was published to Realtime with `replica identity full`
--      (social_12), so that edit is pushed live into the victim's open thread.
--      Blocking closed the front door and left the window open. This is the
--      only remaining way to put new text in front of someone who blocked you,
--      and DMs are deliberately excluded from the AI moderation pass
--      (backend/social_moderation_worker.py), so nothing else would catch it.
--
--      Worse, `tg_content_prefilter` is bound to `messages` as BEFORE INSERT
--      only (social_04), so an UPDATE also skips the wordlist entirely. See
--      section 7 — that half is deliberately left for the moderation owner.
--
--   B. `public_profiles` (social_07, re-declared social_15) filters on
--      `status` / `is_shadowbanned` and nothing else. A blocked user can read
--      the blocker's whole profile — name, bio, avatar, cover, counts — and
--      find them in People search. The block is invisible on the one screen the
--      user most expects it to work on.
--
--   C. `follows_select` is `using (true)`, and — separately and more visibly —
--      blocking never touched the follow EDGES. A blocked user stayed in the
--      blocker's follower list, kept counting toward `follower_count`, and kept
--      receiving the blocker's posts in `fetchFollowingFeed`.
--
--   D. `comments_insert` and `comment_likes_insert` carry no block check, while
--      `post_likes_insert` does. Since social_11 those two are also
--      notification WRITERS: a blocked user can like a comment or reply under a
--      comment they cannot even see, and the trigger rings the blocker's
--      notification bell. The blocker gets a ping they cannot open — the
--      actor's identity hydrates from `public_profiles`, so the row renders as
--      a nameless ghost.
--
-- ===========================================================================
-- 2. DECISION — DMs: freeze the thread, never hide it
-- ===========================================================================
-- social_13 chose "silent, not invisible": blocking stops new messages and
-- leaves the history readable, because `reports` is polymorphic over
-- `target_type = 'message'` and a victim must be able to open the thread and
-- report what was said. Hiding it would destroy the evidence trail at the exact
-- moment it matters, and would let a harasser erase their own history from the
-- victim's device by blocking first. That reasoning is correct and this file
-- keeps it. Reads stay untouched: `messages_select`, `conversations_select` and
-- `conv_participants_select` are not in this migration.
--
-- The change is that "no new text" now means the thread is FROZEN, not just
-- append-blocked. `messages_update` gains the same `conversation_has_block`
-- gate `messages_insert` already has.
--
-- The gate is either-direction and applies to BOTH parties, which is the point:
--
--   * It is symmetric, so the two sides of a blocked thread render identically.
--     An asymmetric rule — B's edits vanish for A but not for B, or A can
--     retract and B cannot — is a side channel that tells one party what the
--     other did. Neither side learns anything here that the send failure does
--     not already tell them.
--   * It costs the blocker the ability to unsend their own messages in that one
--     thread. That is a real, small loss, and it buys the archive: a report
--     filed a week later still points at the text that was actually sent. An
--     immutable record is the correct shape for the evidence surface.
--
-- Not changed, deliberately:
--   * CREATING a conversation is still allowed (`conversations_insert` checks
--     only `created_by = auth.uid()`). At INSERT time a conversation has no
--     participants, so there is nothing to evaluate a block against. The block
--     lands one statement later on `conv_participants_insert` (social_13), so a
--     blocked user's "new" thread is a row they are alone in and can never
--     deliver to. Gating the parent row would be theatre.
--   * `conv_participants_update` (your own `last_read_at`) and
--     `conv_participants_delete` (leaving) stay open. A blocker must be able to
--     open the frozen thread to report it without the badge nagging forever —
--     which is why social_13 excluded blocked threads from `unread_dm_counts()`
--     rather than from the thread list.
--   * Leaving and re-joining is not an escape hatch: `conversation_has_block`
--     is evaluated per send against whoever is in the conversation at that
--     moment, so re-adding yourself re-arms it.
--
-- `is_conversation_participant()` is NOT re-implemented, inlined, or wrapped.
-- It is SECURITY DEFINER precisely to break the `messages` <->
-- `conversation_participants` RLS recursion trap (social_02), and
-- `conversation_has_block()` exists for the same reason one level up
-- (social_13). Both are reused as-is.
--
-- ===========================================================================
-- 3. DECISION — public_profiles: a blocked user has no public profile
-- ===========================================================================
-- The view already models "no public profile" for suspended and shadowbanned
-- users, and the client already renders that as an ordinary not-found. Blocks
-- join that same lane, in both directions: the blocker does not see the blocked
-- user, and the blocked user does not see the blocker.
--
-- Making it either-direction is not symmetry for its own sake. If only the
-- blocker's view were filtered, the blocked user would keep a live window onto
-- the profile they were just removed from — the single most common thing a
-- user means when they say "block".
--
-- WHY THIS IS SAFE INSIDE A `security_invoker = false` VIEW.
--   The view runs as its OWNER so it can read past `user_profiles`' self-only
--   row policy (social_08) — that is the whole reason it exists. The obvious
--   worry is that `auth.uid()` therefore resolves to the owner. It does not.
--   `auth.uid()` reads the `request.jwt.claims` GUC, which PostgREST sets per
--   REQUEST; `security_invoker` selects which ROLE's privileges and row
--   policies apply to the underlying tables and changes no GUC. So inside this
--   view `auth.uid()` is still the caller. Verification query 2 in the footer
--   proves it against the live database rather than asking you to trust this
--   paragraph.
--
--   Corollary worth stating: with no JWT (service_role, psql, the backend)
--   `auth.uid()` is NULL, `is_blocked(null, x)` is false, and the view returns
--   everything it returns today. This migration cannot hide rows from the
--   backend.
--
-- WHY `is_blocked()` AND NOT AN INLINE `not exists` OVER `blocks`.
--   Inside this view an inline subquery would work (the owner bypasses
--   `blocks`' RLS) and would plan as an anti-join. It is still the wrong choice:
--   the identical text inside a POLICY runs as the INVOKER, where
--   `blocks_all using (blocker_id = auth.uid())` silently removes every row
--   where someone else blocked ME — so the "either direction" check quietly
--   becomes one direction and fails open, with no error. That is the same
--   silent-RLS-drop failure class social_07 and social_09 were written for, and
--   it is why `is_blocked` was made SECURITY DEFINER in social_00. Using one
--   spelling everywhere means the view and the policies cannot drift apart, and
--   nobody has to remember which context they are editing.
--
-- WHAT THIS COSTS, AND THE ESCAPE HATCH THE VIEW NEEDS.
--   Hiding the profile also hides the NAME. Two places feel it:
--     * A "Blocked accounts" screen — which the App Store expects, since a user
--       who can block must be able to unblock — would have nothing to render.
--     * `hydrateDmUsers` (dm-service.ts) hydrates DM thread headers from this
--       view, so the frozen thread you are meant to be able to report loses its
--       title.
--   Both are answered by `public.blocked_profiles()` below: a SECURITY DEFINER
--   RPC that returns exactly the users the CALLER blocked, pinned to
--   `auth.uid()` internally so it takes no argument and cannot be aimed at
--   anyone else. It is an unblock list, not a lookup tool.
--
--   The reverse direction has no escape hatch on purpose. If B blocked A, A
--   sees a nameless row and is told nothing — indistinguishable from a
--   suspended or deleted account, which is exactly how the `status` filter
--   already behaves. "Were you blocked or did they leave" is not a question
--   this schema should answer.
--
--   ONE MORE KNOWN CONSEQUENCE, already handled: `isHandleAvailable()`
--   (auth-service.ts) probes this view, so a handle held by someone you have a
--   block with now reads as free. That is not a new failure mode — the function
--   already documents it for suspended/shadowbanned users, calls itself
--   "advisory only", and the save path catches the `uq_user_profiles_handle`
--   unique violation and raises `handle-taken`. This widens an existing,
--   correctly-handled case rather than opening a new one.
--
-- ===========================================================================
-- 4. DECISION — follows: delete the edge, don't filter the list
-- ===========================================================================
-- The tempting fix is `follows_select using (not is_blocked(...))`. Taken
-- alone it is wrong, for a reason that has nothing to do with performance:
-- `user_profiles.follower_count` is DENORMALIZED and maintained by
-- `tg_follows_counts`. Filtering rows out of the list does not decrement the
-- counter, so the profile header would read "12 followers" above a list of 11,
-- permanently, for as long as the block lasts. Row-filtering a list whose count
-- lives in another column manufactures exactly the silent drift social_07 and
-- social_09 exist to prevent.
--
-- So the PRIMARY fix is the honest one: blocking DELETES the follow edges
-- between the two users, in both directions. The existing DELETE branch of
-- `tg_follows_counts` then fires per row and decrements both profiles, so the
-- count and the list agree by construction. This is also what every mainstream
-- social product does, and what users expect: a block is a statement that the
-- relationship is over, not a filter on how it is displayed.
--
-- `tg_blocks_drop_follows` MUST be SECURITY DEFINER, and this is the third time
-- this repo has paid for that lesson. The trigger deletes the row where the
-- OTHER person follows me, and `follows_delete` is
-- `using (follower_id = auth.uid())` — under invoker rights RLS would drop that
-- delete SILENTLY, no error, leaving the block half-applied and the counters
-- asymmetric. Exactly social_07's bug, on a new table.
--
-- Unblocking does NOT restore the follow. That is deliberate and matches every
-- other platform: re-following is one tap, and silently resurrecting a
-- relationship the user ended would be the surprising behavior.
--
-- SECONDARY, defence in depth: `follows_select` does get a block filter, for
-- the edges the deletion cannot reach — third-party edges, e.g. C follows B, A
-- blocked B, A opens C's following list. Those rows carry no counter of A's, so
-- filtering them drifts nothing of A's; C's own `following_count` will read one
-- higher than the list A can see, which is the ordinary and universally
-- accepted shape of a viewer-scoped list.
--
-- ON THE COST OF A PER-ROW `is_blocked()` (the question worth asking):
--   `fetchFollowingFeed` reads every edge for the signed-in user, so this is
--   two calls per followed account, not two per screen. `is_blocked` is a
--   STABLE plpgsql EXISTS over a table with a handful of rows per user, so each
--   call is an index probe — but only ONE of its two directions was actually
--   indexed. The PK `(blocker_id, blocked_id)` serves `blocker = me`;
--   `idx_blocks_blocked` is `(blocked_id)` alone, so the `blocked = me`
--   direction had to fetch each candidate heap row to compare `blocker_id`.
--   `idx_blocks_blocked_blocker` below makes both directions index-only point
--   lookups. That is the right lever at this scale and it is why no index is
--   added to `follows` itself.
--
--   If follower lists ever reach the tens of thousands, the next shape is a
--   single `blocked_ids()` returning the caller's block set once per statement
--   and `follower_id <> all(...)`, not a bigger index. Noted rather than built:
--   it trades a provably-correct check for a cached one, and there is no
--   evidence yet that it is needed.
--
-- ===========================================================================
-- 5. DECISION — notifications: stop the action, then filter the record
-- ===========================================================================
-- Asked plainly: should blocking affect `notifications`? Yes, but the
-- notification is the symptom. Two layers, in this order:
--
--   FIRST, close the write paths that generate them. `comments_insert` and
--   `comment_likes_insert` get the block check `post_likes_insert` has had
--   since social_01. A blocked user then cannot reply under, or like, content
--   they are not permitted to read — which is the actual defect; the missing
--   notification is downstream of it. Both are shaped as
--   `exists (select ... and not is_blocked(...))`, so a row the reader's own
--   RLS already hides yields no row and the insert is REJECTED. Fail-closed,
--   and byte-identical in shape to the `post_likes_insert` line above it.
--
--   SECOND, guard the four notify triggers anyway. They are the last thing
--   before the write, they are the only place that knows the (actor, recipient)
--   pair, and one `is_blocked` call per notification — not per read — is free.
--   Defence in depth against a fifth notification source added later that
--   forgets this file exists.
--
--   THIRD, filter `notifications_select` for rows that already exist. Without
--   it, notifications generated BEFORE the block survive it, and every one of
--   them now renders as a ghost: `fetchNotifications` hydrates actors from
--   `public_profiles`, which as of section 3 returns nothing for a blocked
--   user, so the row draws with `actor: null`. A nameless ping you cannot open
--   is worse than no ping. The list is small and indexed by
--   `(recipient_id, created_at desc)`, so a per-row check here is bounded by
--   one user's own notifications.
--
-- Existing rows are FILTERED, never DELETED. They are part of the same record
-- an abuse report is judged against, and deleting user data on block is not
-- reversible if the block is.
--
-- `notifications_update` is left alone so `markAllNotificationsRead` can still
-- clear rows it can no longer see. Harmless, and it keeps the unread badge
-- honest.
--
-- ===========================================================================
-- 6. COUNTER TRIGGERS — verified, not assumed
-- ===========================================================================
-- social_07 and social_09 exist because a counter update against another user's
-- row was dropped silently by RLS. Every write those triggers make is re-checked
-- against this file:
--
--   tg_follows_counts        SECURITY DEFINER (social_07). Now ALSO fires from
--                            inside tg_blocks_drop_follows, which is itself
--                            definer — nested definer triggers run normally, and
--                            the DELETE branch decrements both profiles. This is
--                            the mechanism that keeps follower_count honest.
--   tg_posts_author_count    Untouched. This file does not change posts_insert
--                            or posts_delete.
--   tg_comments_post_count   Untouched. Its trigger is AFTER INSERT; a
--                            comments_insert REJECTED by the new block check
--                            never reaches it, so no count moves for a row that
--                            was never written.
--   tg_post_likes_count      Untouched.
--   tg_comment_likes_count   Same as tg_comments_post_count: AFTER INSERT, so a
--                            rejected like moves nothing.
--   tg_notify_*              Re-created below. Bodies are social_11 verbatim
--                            apart from the added block guard, and every one
--                            KEEPS `security definer set search_path`. Dropping
--                            that qualifier would silently stop every
--                            notification (notifications has no client INSERT
--                            policy by design).
--
-- A SELECT policy never gates a trigger's UPDATE, so the new `follows_select`
-- and `notifications_select` filters cannot affect any counter. And the new
-- `messages_update` gate touches a table with no counters at all.
--
-- ===========================================================================
-- 7. DELIBERATELY NOT CLOSED (say so out loud rather than let it look complete)
-- ===========================================================================
--   * `tg_content_prefilter` is bound to `messages` as BEFORE INSERT only, so
--     the wordlist never sees an UPDATE. Freezing blocked threads removes the
--     block-shaped half of that; the general hole — anyone editing a clean
--     message into a slur in a thread with no block — is still open. The fix is
--     one line (`before insert or update of body on public.messages`) and it
--     belongs to whoever owns social_18 and the moderation worker, in a file
--     where the false-positive sweep can be re-run. Landing it here would put a
--     moderation change inside a blocking migration and hide it.
--   * GROUP conversations over-block. `conversation_has_block` is true if ANY
--     other participant is blocked, so one block between two members silences
--     the whole thread for both of them. That is inherited from social_13, and
--     it is inert today (`findOrCreateDm` only ever creates 1:1 threads,
--     `is_group` is always false). It is also not obviously fixable: a shared
--     append-only thread cannot show different message sets to different
--     members without splitting it. Left as-is, with eyes open, until groups
--     actually ship.
--   * `conversations` dm_key SQUATTING. Anyone can insert a `conversations` row
--     with a `dm_key` for a pair they are not in; the deterministic id in
--     dm-service.ts means the two real users then collide with it forever. It
--     predates blocking, is not made worse by it, and the fix is a CHECK or a
--     trigger tying `dm_key` to `created_by` — a separate change with its own
--     migration risk.
--   * `post_likes` / `comment_likes` are NOT deleted on block, unlike follows.
--     A like is an event, not a relationship, and removing it would silently
--     change `like_count` on a third party's post for reasons that party cannot
--     see. Follows are deleted because a follow IS the relationship and because
--     its counter belongs to the two people involved.
--   * `mutes` is untouched. Muting is a feed preference, not a safety control.
--   * Storage needs nothing. `post-media` is a PRIVATE bucket readable only by
--     `owner = auth.uid() or is_admin()` (social_05), so a blocked user could
--     never fetch the object even holding the path. `avatars` is a public
--     bucket by design (social_06) and an avatar URL that leaks past a block is
--     a deliberate, documented trade — hiding it would need signed URLs on
--     every profile render.
--   * `reports` stays open to blocked users in both directions. Blocking
--     someone must never disarm their ability to report you, or "block first"
--     becomes a way to buy immunity.
--
-- ===========================================================================
-- 8. SAFETY
-- ===========================================================================
-- Additive and idempotent: `create or replace` for every function and the view,
-- `drop policy if exists` before each policy, `create index if not exists`. One
-- transaction — any failure rolls the whole file back and leaves today's
-- behavior intact.
--
-- The ONE data-changing statement is the follow-edge backfill at the end of
-- section 4's block, which deletes follow rows for pairs that are ALREADY
-- blocked. It is scoped by a join to `blocks`, so it can only touch pairs where
-- one user has explicitly blocked the other, and it fires the counter trigger
-- per row so the profiles stay consistent. Run the "how many rows will this
-- delete" query in the footer FIRST if you want to see the blast radius before
-- committing.
--
-- Run as `postgres` (SQL editor or `supabase db push`) — replacing a view owned
-- by the owner role requires it.

begin;

-- ---------------------------------------------------------------------------
-- 1. Make `is_blocked()` cheap in BOTH directions
-- ---------------------------------------------------------------------------
-- The PK is (blocker_id, blocked_id), which serves the "I blocked them" half as
-- a point lookup. The "they blocked me" half only had `idx_blocks_blocked` on
-- (blocked_id), so it found candidate rows by index and then had to visit the
-- heap for each to compare blocker_id. Adding blocker_id to the index makes it
-- a point lookup too — which matters now that `is_blocked` is called per row
-- from `follows_select`, `notifications_select` and the profile view.
create index if not exists idx_blocks_blocked_blocker
  on public.blocks (blocked_id, blocker_id);

-- ---------------------------------------------------------------------------
-- 2. DMs: freeze a blocked thread (section 2)
-- ---------------------------------------------------------------------------
-- Adds participation AND the block gate to UPDATE. Participation was missing
-- entirely in social_02 — `sender_id = auth.uid()` is true for your own message
-- even after you have left the conversation.
--
-- Both USING and WITH CHECK carry the same predicate: USING decides which rows
-- you may target, WITH CHECK validates the result. Omitting either leaves an
-- edit path open.
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id, auth.uid())
    and not public.conversation_has_block(conversation_id, auth.uid())
  )
  with check (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id, auth.uid())
    and not public.conversation_has_block(conversation_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3. public_profiles: a blocked user has no public profile (section 3)
-- ---------------------------------------------------------------------------
-- Column list is social_15's, in social_15's order, unchanged — CREATE OR
-- REPLACE VIEW may only APPEND columns, and this migration appends none. Only
-- the WHERE clause moves.
create or replace view public.public_profiles
  with (security_invoker = false) as
  select
    user_id,
    display_name,
    avatar_url,
    handle,
    bio,
    location,
    social_link,
    is_verified,
    reputation,
    follower_count,
    following_count,
    post_count,
    created_at,
    cover_url
  from public.user_profiles
  -- Suspended, banned, and shadowbanned users simply have no public profile.
  where status = 'active'
    and not is_shadowbanned
    -- ...and neither does anyone on either side of a block with the caller.
    -- `is_blocked` (SECURITY DEFINER) rather than an inline subquery: see the
    -- "WHY is_blocked() AND NOT AN INLINE not exists" note in the header. With
    -- no JWT this is false for every row, so service_role reads are unchanged.
    and not public.is_blocked((select auth.uid()), user_id);

grant select on public.public_profiles to authenticated;

-- The unblock list. The ONLY way to read a blocked user's presentational
-- columns, and it is not a lookup tool: it takes no argument, pins the caller
-- to `auth.uid()` internally, and returns strictly the rows where the CALLER is
-- the blocker. B cannot use it to see A.
--
-- The column list is spelled out rather than declared as
-- `returns setof public.public_profiles`. Borrowing the view's row type would
-- tie the two together at the type level — which sounds like a feature until
-- the next author needs to REORDER or RENAME a column on the view. social_15
-- already documents that this forces a drop-and-recreate, and a function
-- depending on the view's rowtype turns that into a hard "cannot drop view
-- because other objects depend on it" mid-migration. Keeping the columns
-- explicit costs one comment (keep this list in step with the view above) and
-- leaves the view free to change shape.
--
-- No `status` / `is_shadowbanned` filter, deliberately: you must be able to
-- unblock an account that has since been suspended, and the caller already
-- knows this user exists because they blocked them by hand.
create or replace function public.blocked_profiles()
returns table (
  user_id         uuid,
  display_name    text,
  avatar_url      text,
  handle          citext,
  bio             text,
  location        text,
  social_link     text,
  is_verified     boolean,
  reputation      integer,
  follower_count  integer,
  following_count integer,
  post_count      integer,
  created_at      timestamptz,
  cover_url       text
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    up.user_id,
    up.display_name,
    up.avatar_url,
    up.handle,
    up.bio,
    up.location,
    up.social_link,
    up.is_verified,
    up.reputation,
    up.follower_count,
    up.following_count,
    up.post_count,
    up.created_at,
    up.cover_url
  from public.user_profiles up
  join public.blocks b on b.blocked_id = up.user_id
  where b.blocker_id = auth.uid()
  order by b.created_at desc;
$$;

revoke all on function public.blocked_profiles() from public;
grant execute on function public.blocked_profiles() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. follows: blocking ends the relationship (section 4)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER is load-bearing. This deletes the edge where the OTHER
-- person follows the blocker, and `follows_delete` is
-- `using (follower_id = auth.uid())` — under invoker rights that delete is
-- dropped SILENTLY (no error), leaving the block half-applied. Same failure
-- class as social_07 / social_09.
--
-- The DELETE fires `tg_follows_counts` once per row, which is what keeps
-- `follower_count` / `following_count` in step with the shortened lists.
--
-- No exception handler: this runs inside the user's block statement, and a
-- block that silently half-succeeds is worse than one that fails loudly.
create or replace function public.tg_blocks_drop_follows()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.follows
   where (follower_id = new.blocker_id and followee_id = new.blocked_id)
      or (follower_id = new.blocked_id and followee_id = new.blocker_id);
  return null;
end;
$$;

drop trigger if exists blocks_drop_follows on public.blocks;
create trigger blocks_drop_follows after insert on public.blocks
  for each row execute function public.tg_blocks_drop_follows();

-- Defence in depth for the edges the trigger cannot reach: third-party edges
-- that merely MENTION someone the caller has a block with. Replaces
-- `using (true)`.
--
-- `(select auth.uid())` is an InitPlan — evaluated once per statement rather
-- than once per row (social_08 uses the same idiom).
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select to authenticated
  using (
    not public.is_blocked((select auth.uid()), follower_id)
    and not public.is_blocked((select auth.uid()), followee_id)
  );

-- Backfill: apply the new rule to blocks that already exist. Scoped by a join to
-- `blocks`, so it can only touch a pair where one user explicitly blocked the
-- other. Fires the counter trigger per row, so the profiles stay consistent.
-- Idempotent — a second run finds nothing left to delete.
delete from public.follows f
 using public.blocks b
 where (f.follower_id = b.blocker_id and f.followee_id = b.blocked_id)
    or (f.follower_id = b.blocked_id and f.followee_id = b.blocker_id);

-- ---------------------------------------------------------------------------
-- 5. Close the two write paths that had no block check (section 5, first layer)
-- ---------------------------------------------------------------------------
-- comment_author_id(): SECURITY DEFINER is REQUIRED, not stylistic. The reply
-- check below needs to read `comments` from inside a policy ON `comments`, and
-- an inline subquery there re-enters the same policy and fails every read of
-- the table with 42P17 ("infinite recursion detected in policy for relation
-- comments"). social_17 hit this exact wall with `comment_has_live_reply` and
-- broke it the same way. Running as the owner escapes the cycle.
create or replace function public.comment_author_id(p_comment uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select author_id from public.comments where id = p_comment;
$$;

grant execute on function public.comment_author_id(uuid) to authenticated;

-- comments_insert: you may not comment on a post whose author you have a block
-- with. Same `exists (... and not is_blocked ...)` shape as `post_likes_insert`
-- (social_01): `posts` RLS applies to the subquery, so a post the caller cannot
-- read yields no row and the insert is REJECTED. Fail-closed.
--
-- The second clause covers replying UNDER a blocked person's comment on a
-- third party's post — the post author check alone would let that through, and
-- the reply would then hang publicly off a comment the replier cannot see.
-- `comment_author_id` (definer) is what makes this expressible without
-- recursion. A null parent yields null and `is_blocked(x, null)` is false, so a
-- top-level comment is unaffected.
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.posts p
      where p.id = post_id
        and not public.is_blocked(auth.uid(), p.author_id)
    )
    and (
      parent_comment_id is null
      or not public.is_blocked(auth.uid(), public.comment_author_id(parent_comment_id))
    )
  );

-- comment_likes_insert: the parity fix. `post_likes_insert` has carried this
-- check since social_01; its comment twin never did.
drop policy if exists comment_likes_insert on public.comment_likes;
create policy comment_likes_insert on public.comment_likes for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.comments c
      where c.id = comment_id
        and not public.is_blocked(auth.uid(), c.author_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 6. notifications (section 5, layers two and three)
-- ---------------------------------------------------------------------------
-- Bodies are social_11 verbatim apart from the block guard folded into each
-- early-return. Every one KEEPS `security definer set search_path` — dropping
-- it would silently stop all notifications, because `notifications` has no
-- client INSERT policy by design.
create or replace function public.tg_notify_follow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.follower_id = new.followee_id
     or public.is_blocked(new.follower_id, new.followee_id) then
    return null;
  end if;
  insert into public.notifications (recipient_id, actor_id, type)
  values (new.followee_id, new.follower_id, 'follow')
  on conflict do nothing;
  return null;
end;
$$;

create or replace function public.tg_notify_post_like()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  post_author uuid;
begin
  select author_id into post_author from public.posts where id = new.post_id;
  -- The post may already be gone; a missing author is not an error here.
  if post_author is null
     or post_author = new.user_id
     or public.is_blocked(new.user_id, post_author) then
    return null;
  end if;
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  values (post_author, new.user_id, 'like', new.post_id)
  on conflict do nothing;
  return null;
end;
$$;

create or replace function public.tg_notify_comment_like()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  comment_author uuid;
  parent_post    uuid;
begin
  select author_id, post_id into comment_author, parent_post
    from public.comments where id = new.comment_id;
  if comment_author is null
     or comment_author = new.user_id
     or public.is_blocked(new.user_id, comment_author) then
    return null;
  end if;
  -- post_id is carried so the client can deep-link straight to the thread.
  insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
  values (comment_author, new.user_id, 'like', parent_post, new.comment_id)
  on conflict do nothing;
  return null;
end;
$$;

-- Two recipients, so the guard is applied per recipient rather than once at the
-- top: a reply can legitimately notify the post author while being blocked by
-- the parent comment's author, or the reverse.
create or replace function public.tg_notify_comment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  post_author   uuid;
  parent_author uuid;
begin
  select author_id into post_author from public.posts where id = new.post_id;

  if post_author is not null
     and post_author <> new.author_id
     and not public.is_blocked(new.author_id, post_author) then
    insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
    values (post_author, new.author_id, 'comment', new.post_id, new.id)
    on conflict do nothing;
  end if;

  if new.parent_comment_id is not null then
    select author_id into parent_author
      from public.comments where id = new.parent_comment_id;
    -- Skip when the parent's author is the poster we just notified, or is the
    -- replier themselves — one event should never notify anyone twice.
    if parent_author is not null
       and parent_author <> new.author_id
       and parent_author is distinct from post_author
       and not public.is_blocked(new.author_id, parent_author) then
      insert into public.notifications (recipient_id, actor_id, type, post_id, comment_id)
      values (parent_author, new.author_id, 'comment', new.post_id, new.id)
      on conflict do nothing;
    end if;
  end if;

  return null;
end;
$$;

-- Rows that predate the block: filtered, never deleted (section 5). `actor_id`
-- is nullable — a deleted account leaves a null FK — so the null branch keeps
-- those rows visible rather than having `is_blocked(x, null)` decide it.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (
    recipient_id = auth.uid()
    and (actor_id is null or not public.is_blocked(auth.uid(), actor_id))
  );

commit;

-- ===========================================================================
-- VERIFICATION — run after applying
-- ===========================================================================
-- These use the SQL-editor RLS-impersonation idiom: inside a transaction, set
-- the role and the JWT claims GUC that `auth.uid()` reads, run the query, then
-- ROLLBACK so nothing sticks. Substitute two real user ids.
--
--   -- pick two accounts to play A (blocker) and B (blocked)
--   select user_id, handle, display_name from public.user_profiles limit 5;
--
-- Throughout: A = the blocker, B = the blocked user, C = an unrelated third
-- user used to prove the unblocked path is untouched.
--
-- ---------------------------------------------------------------------------
-- 0. Blast radius of the backfill, BEFORE you commit (run it before applying)
-- ---------------------------------------------------------------------------
--   select count(*) from public.follows f
--     join public.blocks b
--       on (f.follower_id = b.blocker_id and f.followee_id = b.blocked_id)
--       or (f.follower_id = b.blocked_id and f.followee_id = b.blocker_id);
--   -- Expected today: 0 (blocking has only just shipped). Any other number is
--   -- the number of follow edges this migration will delete.
--
-- ---------------------------------------------------------------------------
-- 1. Set up the block (as A, so the `blocks_all` policy is exercised too)
-- ---------------------------------------------------------------------------
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   insert into public.blocks (blocker_id, blocked_id) values ('<A>','<B>')
--     on conflict do nothing;
--   commit;
--
--   -- The follow edges between A and B are now gone, both directions:
--   select * from public.follows
--    where (follower_id = '<A>' and followee_id = '<B>')
--       or (follower_id = '<B>' and followee_id = '<A>');   -- expected: 0 rows
--
--   -- ...and the counters moved with them (this is the social_07 failure mode;
--   -- if the trigger were not SECURITY DEFINER, one side would be stale):
--   select user_id, follower_count, following_count from public.user_profiles
--    where user_id in ('<A>','<B>');
--   -- Cross-check against the truth:
--   select p.user_id,
--          p.follower_count,
--          (select count(*) from public.follows where followee_id = p.user_id) as real_followers,
--          p.following_count,
--          (select count(*) from public.follows where follower_id = p.user_id) as real_following
--     from public.user_profiles p where p.user_id in ('<A>','<B>');
--   -- expected: follower_count = real_followers and following_count =
--   -- real_following for BOTH rows.
--
-- ---------------------------------------------------------------------------
-- 2. auth.uid() really is the CALLER inside the definer view (section 3)
-- ---------------------------------------------------------------------------
-- Prove the assumption rather than trusting it. If this returns the owner's id
-- or null, the view's filter is inert and everything below is meaningless.
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--   select auth.uid();                     -- expected: <B>
--   select count(*) from public.public_profiles where user_id = '<B>';
--   -- expected: 1 — B can still see B. (is_blocked(B,B) is false; the
--   -- `blocker_id <> blocked_id` CHECK on `blocks` makes a self-block
--   -- impossible, so the view can never hide you from yourself.)
--   rollback;
--
-- ---------------------------------------------------------------------------
-- 3. B cannot see A's profile, and cannot find A in search
-- ---------------------------------------------------------------------------
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--
--   select count(*) from public.public_profiles where user_id = '<A>';
--   -- expected: 0  (before this migration: 1)
--
--   -- People search, exactly as searchUsers() issues it:
--   select user_id, handle from public.public_profiles
--    where handle ilike '<A-handle-prefix>%' or display_name ilike '<A-name-prefix>%';
--   -- expected: no row for <A>
--
--   -- ...and the reverse direction, as A. A cannot see B either:
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   select count(*) from public.public_profiles where user_id = '<B>';   -- expected: 0
--
--   -- But A CAN still resolve B for the unblock list:
--   select user_id, display_name, handle from public.blocked_profiles();
--   -- expected: one row, <B>. This is the App Store "must be able to unblock"
--   -- path, and it is the only way a name comes back.
--
--   -- ...and it is not a lookup tool. As B, it returns nothing:
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--   select count(*) from public.blocked_profiles();   -- expected: 0
--   rollback;
--
-- ---------------------------------------------------------------------------
-- 4. B does not appear in A's follower list, and vice versa
-- ---------------------------------------------------------------------------
-- Two layers to check separately, because they fail differently.
--
--   -- (a) The edge is GONE (the trigger). Even as service_role / postgres,
--   --     with RLS out of the picture:
--   reset role;
--   select count(*) from public.follows
--    where (follower_id = '<B>' and followee_id = '<A>')
--       or (follower_id = '<A>' and followee_id = '<B>');   -- expected: 0
--
--   -- (b) The POLICY also hides any third-party edge that mentions the other
--   --     party. Have C follow A first, then look as B:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--   select * from public.follows where followee_id = '<A>';
--   -- expected: 0 rows — B cannot enumerate A's followers at all, even the
--   -- ones unrelated to B. (before this migration: every edge, `using (true)`)
--   rollback;
--
--   -- The exact query fetchFollowers() issues, as A, must still work:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   select follower_id from public.follows where followee_id = '<A>'
--    order by created_at desc limit 100;
--   -- expected: C is present, B is absent.
--   rollback;
--
-- ---------------------------------------------------------------------------
-- 5. B cannot message A — send, edit, or re-thread
-- ---------------------------------------------------------------------------
-- Use an existing thread between A and B (or create one BEFORE the block).
--   select id, dm_key from public.conversations
--    where dm_key = (select string_agg(x, ':' order by x) from (values ('<A>'),('<B>')) v(x));
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--
--   -- SEND (social_13 already closed this; re-checked because this file edits
--   -- the neighbouring policy and must not have regressed it):
--   insert into public.messages (conversation_id, sender_id, body)
--   values ('<conv>', '<B>', 'blocked send attempt');
--   -- expected: ERROR 42501 new row violates row-level security policy
--
--   -- EDIT — this is the hole THIS file closes:
--   update public.messages set body = 'edited after being blocked'
--    where conversation_id = '<conv>' and sender_id = '<B>';
--   -- expected: 0 rows updated (USING filters them out — an UPDATE that matches
--   -- nothing is not an error, which is exactly why this was easy to miss).
--
--   -- ...and the body is untouched:
--   select body from public.messages where conversation_id = '<conv>' and sender_id = '<B>';
--
--   -- RE-THREAD: B cannot pull A into a fresh conversation.
--   insert into public.conversations (id, is_group, created_by)
--     values ('<fresh-uuid>', false, '<B>');            -- allowed, see section 2
--   insert into public.conversation_participants (conversation_id, user_id)
--     values ('<fresh-uuid>', '<B>');                   -- allowed (self)
--   insert into public.conversation_participants (conversation_id, user_id)
--     values ('<fresh-uuid>', '<A>');
--   -- expected: ERROR 42501 — this is the line that makes the thread
--   -- undeliverable.
--   rollback;
--
--   -- HISTORY IS STILL READABLE, by design (social_13's reporting rationale) —
--   -- and symmetrically, so neither side learns anything from the other's view:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   select count(*) from public.messages where conversation_id = '<conv>';   -- expected: > 0
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--   select count(*) from public.messages where conversation_id = '<conv>';   -- expected: SAME number
--   rollback;
--
--   -- A can still file the report the history exists for:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   insert into public.reports (reporter_id, target_type, target_id, reason)
--   values ('<A>', 'message', '<message-id>', 'harassment');   -- expected: succeeds
--   rollback;
--
-- ---------------------------------------------------------------------------
-- 6. B cannot ring A's notification bell
-- ---------------------------------------------------------------------------
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--
--   -- Comment on A's post (B knows the id from before the block):
--   insert into public.comments (post_id, author_id, body)
--   values ('<A-post-id>', '<B>', 'blocked comment');
--   -- expected: ERROR 42501
--
--   -- Like A's comment:
--   insert into public.comment_likes (comment_id, user_id)
--   values ('<A-comment-id>', '<B>');
--   -- expected: ERROR 42501
--
--   -- Reply under A's comment on C's post (the vector the post-author check
--   -- alone would miss):
--   insert into public.comments (post_id, author_id, parent_comment_id, body)
--   values ('<C-post-id>', '<B>', '<A-comment-id>', 'blocked reply');
--   -- expected: ERROR 42501
--   rollback;
--
--   -- Pre-block notifications from B are hidden from A rather than deleted:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   select count(*) from public.notifications where actor_id = '<B>';   -- expected: 0
--   rollback;
--   reset role;
--   select count(*) from public.notifications
--    where recipient_id = '<A>' and actor_id = '<B>';
--   -- expected: unchanged from before the block — filtered, not destroyed.
--
-- ---------------------------------------------------------------------------
-- 7. THE CONTROL: an UNBLOCKED pair is completely unaffected
-- ---------------------------------------------------------------------------
-- Every check above must fail in the opposite direction for A and C, who have
-- no block between them. If any of these regress, the filter is too broad.
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<C>","role":"authenticated"}';
--
--   select count(*) from public.public_profiles where user_id = '<A>';   -- expected: 1
--   select count(*) from public.follows where followee_id = '<A>';       -- expected: > 0
--   insert into public.comments (post_id, author_id, body)
--     values ('<A-post-id>', '<C>', 'ordinary comment');                 -- expected: succeeds
--   insert into public.comment_likes (comment_id, user_id)
--     values ('<A-comment-id>', '<C>');                                  -- expected: succeeds
--   rollback;
--
--   -- A receives both notifications:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   select type, actor_id from public.notifications
--    where recipient_id = '<A>' and actor_id = '<C>' order by created_at desc;
--   -- expected: the comment and the like are both there.
--   rollback;
--
--   -- ...and A and C can still DM each other in both directions:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<C>","role":"authenticated"}';
--   insert into public.messages (conversation_id, sender_id, body)
--     values ('<A-C-conv>', '<C>', 'still works');                       -- expected: succeeds
--   update public.messages set body = 'edited, still works'
--    where conversation_id = '<A-C-conv>' and sender_id = '<C>';
--   -- expected: 1 row updated — the freeze is scoped to blocked threads only.
--   rollback;
--
-- ---------------------------------------------------------------------------
-- 8. Unblock restores everything except the follow (documented, not a bug)
-- ---------------------------------------------------------------------------
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<A>","role":"authenticated"}';
--   delete from public.blocks where blocker_id = '<A>' and blocked_id = '<B>';
--   commit;
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<B>","role":"authenticated"}';
--   select count(*) from public.public_profiles where user_id = '<A>';   -- expected: 1
--   -- ...but the follow edge does NOT come back:
--   select count(*) from public.follows
--    where follower_id = '<B>' and followee_id = '<A>';                  -- expected: 0
--   rollback;
--
-- ---------------------------------------------------------------------------
-- 9. Shape check — confirm the live database matches this file
-- ---------------------------------------------------------------------------
--   select tablename, policyname, cmd, qual, with_check
--     from pg_policies
--    where schemaname = 'public'
--      and policyname in ('messages_update','follows_select','notifications_select',
--                         'comments_insert','comment_likes_insert')
--    order by tablename, policyname;
--
--   -- Every trigger function this file relies on must still be definer with a
--   -- pinned search_path. A false in `prosecdef` here is the silent-drop bug.
--   select proname, prosecdef, proconfig
--     from pg_proc
--    where proname in ('is_blocked','conversation_has_block','is_conversation_participant',
--                      'tg_blocks_drop_follows','tg_follows_counts','comment_author_id',
--                      'blocked_profiles','tg_notify_follow','tg_notify_post_like',
--                      'tg_notify_comment_like','tg_notify_comment')
--    order by proname;
--   -- expected: prosecdef = t for ALL of them, proconfig = {search_path=public,pg_temp}
--   -- (is_blocked / is_conversation_participant predate the pg_temp convention
--   -- and read {search_path=public}; that is social_00/social_02 as shipped and
--   -- is not changed here.)
--
--   select relname, relrowsecurity from pg_class
--    where relname in ('follows','blocks','notifications','messages','comments','comment_likes')
--      and relnamespace = 'public'::regnamespace;
--   -- expected: relrowsecurity = t for all six.
