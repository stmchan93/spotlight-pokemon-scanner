import { capturePostHogEvent } from '@/lib/observability/posthog';
import { isMissingFunctionError } from '@/lib/postgrest-errors';
import { supabase } from '@/lib/supabase';

/**
 * Client-direct Supabase reads for the social feed (Phase 3a — read-only).
 *
 * This mirrors `profile-service.ts` exactly: every function is client-direct,
 * NEVER throws, and resolves to `[]` on any failure (missing Supabase client,
 * RLS-filtered rows, a rejected query). RLS already filters `posts` /
 * `post_media` to the rows a viewer may see (visible/approved), so these reads
 * carry only the presentational filters on top.
 *
 * Two-step hydration, same reason as `fetchFollowList`: `posts.author_id` FKs to
 * `auth.users`, not to the `public_profiles` view, and `post_media` isn't an
 * auto-embeddable relationship we want to over-select from — so we read the base
 * rows, collect ids, then hydrate authors through the moderation-filtered
 * `public_profiles` view and media through `post_media`. A blocked/suspended
 * author simply drops out of the author map (their post shows with `author:
 * null`), and we NEVER select `storage_path` or any moderation column off
 * `post_media`.
 */

const POSTS_TABLE = 'posts';
const POST_MEDIA_TABLE = 'post_media';
const FOLLOWS_TABLE = 'follows';
const PUBLIC_PROFILES_VIEW = 'public_profiles';

/** Default page size for every feed read. */
const DEFAULT_LIMIT = 20;

// Presentational post columns only. `content_status` / `deleted_at` are read so
// we can filter deleted rows out client-side as a belt-and-braces guard on top
// of RLS; they never reach the normalized `FeedPost`.
const postSelect =
  'id, author_id, body, card_id, like_count, comment_count, created_at, content_status, deleted_at';

// Media presentational columns ONLY. Deliberately omits `storage_path` and
// `moderation_status` — the image bytes are served through the authenticated
// backend proxy by media id, not by any path the client holds.
const postMediaSelect = 'id, post_id, width, height, blurhash, position';

// Same media columns, embedded in the post read so a feed page costs one round
// trip instead of two (posts, then media). PostgREST resolves the embed from the
// `post_media.post_id -> posts.id` FK and applies `post_media`'s own RLS. If the
// relationship can't be resolved the whole read errors, so callers fall back to
// the separate media query rather than showing an empty feed.
const postSelectWithMedia = `${postSelect}, post_media(${postMediaSelect})`;

// Just the author identity columns the post card renders. A subset of the full
// public-profile view select.
const postAuthorSelect = 'user_id, display_name, avatar_url, handle, is_verified';

type PostRow = {
  id: string;
  author_id: string;
  body: string | null;
  card_id: string | null;
  like_count: number | null;
  comment_count: number | null;
  created_at: string;
  content_status: string | null;
  deleted_at: string | null;
  /** Present only when the read used the embedded-media select. */
  post_media?: PostMediaRow[] | null;
};

type PostMediaRow = {
  id: string;
  post_id: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  position: number | null;
};

type PostAuthorRow = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  is_verified: boolean | null;
};

export type FeedPostAuthor = {
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
};

export type FeedPostMedia = {
  id: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
};

export type FeedPost = {
  id: string;
  authorId: string;
  /** Null when the author isn't publicly visible (blocked/suspended/hidden). */
  author: FeedPostAuthor | null;
  body: string | null;
  cardId: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  media: FeedPostMedia[];
};

/**
 * The signed-in user's id, or null when unauthenticated / Supabase absent.
 *
 * Reads the persisted session (local, no I/O) and only falls back to
 * `auth.getUser()` — which revalidates against the auth server on every call —
 * when there is no session cached. Every like/comment/follow write goes through
 * here, so the old unconditional `getUser()` put a full auth round trip in front
 * of each one. The id is only used to shape the query; RLS still validates the
 * JWT server-side, so trusting the cached session costs nothing.
 */
async function currentUserId(): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  try {
    if (typeof supabase.auth.getSession === 'function') {
      const { data } = await supabase.auth.getSession();
      const sessionUserId = data?.session?.user?.id ?? null;
      if (sessionUserId) {
        return sessionUserId;
      }
    }
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

function mapAuthor(row: PostAuthorRow): FeedPostAuthor {
  return {
    displayName: row.display_name,
    handle: row.handle ?? null,
    avatarUrl: row.avatar_url ?? null,
    isVerified: row.is_verified === true,
  };
}

type HydrateOptions = {
  /** Authors the caller already holds, so we can skip the `public_profiles` read. */
  knownAuthorsById?: Map<string, FeedPostAuthor>;
  /** True when the post read already embedded `post_media` rows. */
  mediaEmbedded?: boolean;
};

function toFeedMedia(row: PostMediaRow): FeedPostMedia {
  return {
    id: row.id,
    width: row.width ?? null,
    height: row.height ?? null,
    blurhash: row.blurhash ?? null,
  };
}

/**
 * Turn base post rows into normalized `FeedPost[]`, hydrating author identity via
 * `public_profiles` and media via `post_media`. Preserves the incoming post order
 * (the caller sorts newest-first). Returns `[]` on any failure.
 *
 * Both hydration reads are skippable: `mediaEmbedded` when the post query already
 * carried its media, `knownAuthorsById` when the caller knows every author (the
 * owner's own Activity tab). With both, hydration costs zero extra round trips.
 */
async function hydratePosts(rows: PostRow[], options: HydrateOptions = {}): Promise<FeedPost[]> {
  if (!supabase || rows.length === 0) {
    return [];
  }

  const authorsById = new Map<string, FeedPostAuthor>(options.knownAuthorsById ?? []);
  const mediaByPost = new Map<string, FeedPostMedia[]>();

  if (options.mediaEmbedded) {
    for (const row of rows) {
      const embedded = row.post_media ?? [];
      if (embedded.length === 0) {
        continue;
      }
      // PostgREST doesn't order embedded rows unless asked; sort here so the
      // first image is always position 0.
      mediaByPost.set(
        row.id,
        [...embedded].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(toFeedMedia),
      );
    }
  }

  const missingAuthorIds = Array.from(
    new Set(rows.map((row) => row.author_id).filter((id) => Boolean(id) && !authorsById.has(id))),
  );
  const needsMedia = !options.mediaEmbedded;

  try {
    const [authorResult, mediaResult] = await Promise.all([
      missingAuthorIds.length > 0
        ? supabase.from(PUBLIC_PROFILES_VIEW).select(postAuthorSelect).in('user_id', missingAuthorIds)
        : Promise.resolve({ data: [], error: null }),
      needsMedia
        ? supabase
            .from(POST_MEDIA_TABLE)
            .select(postMediaSelect)
            .in('post_id', rows.map((row) => row.id))
            .order('position', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (!authorResult.error && authorResult.data) {
      for (const row of authorResult.data as PostAuthorRow[]) {
        authorsById.set(row.user_id, mapAuthor(row));
      }
    }

    // A media read failure just yields text-only posts rather than dropping them.
    if (needsMedia && !mediaResult.error && mediaResult.data) {
      for (const row of mediaResult.data as PostMediaRow[]) {
        const list = mediaByPost.get(row.post_id) ?? [];
        list.push(toFeedMedia(row));
        mediaByPost.set(row.post_id, list);
      }
    }
  } catch {
    // Fall through with whatever hydrated — posts still render (author/media may
    // be absent) rather than the whole feed collapsing to empty.
  }

  return rows.map((row) => ({
    id: row.id,
    authorId: row.author_id,
    author: authorsById.get(row.author_id) ?? null,
    body: row.body ?? null,
    cardId: row.card_id ?? null,
    likeCount: row.like_count ?? 0,
    commentCount: row.comment_count ?? 0,
    createdAt: row.created_at,
    media: mediaByPost.get(row.id) ?? [],
  }));
}

// The PostgREST filter builder's generics are deep enough that threading them
// through a helper trips `tsc`'s instantiation-depth limit; `any` here keeps the
// query-shaping callback ergonomic without changing runtime behavior. The result
// is re-cast to `PostRow[]` before it leaves the module.
type PostFilter = (query: any) => any;

/**
 * Shared post read: newest-first, deleted rows excluded, keyset-paginated by a
 * `before` created_at cursor. The caller supplies the row filter (author id, card
 * id, or a set of followee ids). Returns `[]` for every failure mode.
 */
async function fetchPosts(
  applyFilter: PostFilter,
  limit: number,
  before?: string,
  knownAuthorsById?: Map<string, FeedPostAuthor>,
): Promise<FeedPost[]> {
  if (!supabase) {
    return [];
  }

  const runQuery = (select: string) => {
    let query = supabase!
      .from(POSTS_TABLE)
      .select(select)
      // Posts have NO tombstone concept — a soft-deleted post just disappears,
      // so both filters stay. They are load-bearing rather than belt-and-braces
      // now: `posts_select` lets an author read their own soft-deleted rows (so
      // the soft-delete write's RETURNING works), and without these the author
      // would keep seeing their own deleted post in their Activity tab.
      .is('deleted_at', null)
      .neq('content_status', 'deleted');

    query = applyFilter(query);

    if (before) {
      query = query.lt('created_at', before);
    }

    return query.order('created_at', { ascending: false }).limit(limit);
  };

  try {
    // Preferred shape: one round trip with media embedded. If the embed can't be
    // resolved (relationship not exposed), retry with the plain select and let
    // hydration fetch media separately rather than surfacing an empty feed.
    let mediaEmbedded = true;
    let { data, error } = await runQuery(postSelectWithMedia);
    if (error) {
      mediaEmbedded = false;
      ({ data, error } = await runQuery(postSelect));
    }

    if (error || !data) {
      return [];
    }

    // The embed string isn't in the generated schema types, so PostgREST's
    // generics can't infer the row shape; the runtime shape is `PostRow[]`.
    return hydratePosts(data as unknown as PostRow[], { knownAuthorsById, mediaEmbedded });
  } catch {
    return [];
  }
}

/**
 * One post by id, hydrated exactly like a feed row so the same `PostCard`
 * renders it. Null when it is gone, deleted, or not visible to this viewer —
 * which a notification can outlive, so the caller has to handle it.
 *
 * Same media-embed fallback as the feed reads: one round trip when PostgREST can
 * resolve the relationship, two when it cannot.
 */
export async function fetchPostById(postId: string): Promise<FeedPost | null> {
  if (!supabase || !postId) {
    return null;
  }
  const runQuery = (select: string) =>
    supabase!
      .from(POSTS_TABLE)
      .select(select)
      .eq('id', postId)
      .is('deleted_at', null)
      .neq('content_status', 'deleted')
      .limit(1);

  try {
    let { data, error } = await runQuery(postSelectWithMedia);
    let mediaEmbedded = true;
    if (error) {
      mediaEmbedded = false;
      ({ data, error } = await runQuery(postSelect));
    }
    if (error || !data || data.length === 0) {
      return null;
    }
    const posts = await hydratePosts(data as unknown as PostRow[], { mediaEmbedded });
    return posts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Posts by the authors the signed-in user follows, newest first. Empty until the
 * viewer follows someone (or when unauthenticated). Two reads: the followee ids
 * from `follows`, then their posts.
 */
export async function fetchFollowingFeed(limit = DEFAULT_LIMIT, before?: string): Promise<FeedPost[]> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return [];
  }

  try {
    const { data: edges, error } = await supabase
      .from(FOLLOWS_TABLE)
      .select('followee_id')
      .eq('follower_id', me);
    if (error || !edges || edges.length === 0) {
      return [];
    }

    const followeeIds = Array.from(
      new Set(
        edges
          .map((row) => (row as { followee_id: string | null }).followee_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (followeeIds.length === 0) {
      return [];
    }

    return fetchPosts((query) => query.in('author_id', followeeIds), limit, before);
  } catch {
    return [];
  }
}

/** All recent visible posts, newest first (global/discovery feed). */
export function fetchGlobalFeed(limit = DEFAULT_LIMIT, before?: string): Promise<FeedPost[]> {
  return fetchPosts((query) => query, limit, before);
}

/** Posts anchored to one card (`card_id = cardId`), newest first. */
export function fetchCardPosts(cardId: string, limit = DEFAULT_LIMIT, before?: string): Promise<FeedPost[]> {
  const trimmed = (cardId ?? '').trim();
  if (!trimmed) {
    return Promise.resolve([]);
  }
  return fetchPosts((query) => query.eq('card_id', trimmed), limit, before);
}

type AuthorPostsOptions = {
  before?: string;
  /**
   * The author's identity when the caller already has it (the signed-in user on
   * their own Activity tab). Every row is by this author, so passing it removes
   * the `public_profiles` hydration read entirely.
   */
  knownAuthor?: FeedPostAuthor | null;
  limit?: number;
};

/** Posts by one author, newest first — the profile Activity tab. */
export function fetchAuthorPosts(authorId: string, options: AuthorPostsOptions = {}): Promise<FeedPost[]> {
  const trimmed = (authorId ?? '').trim();
  if (!trimmed) {
    return Promise.resolve([]);
  }
  const knownAuthorsById = options.knownAuthor
    ? new Map([[trimmed, options.knownAuthor]])
    : undefined;
  return fetchPosts(
    (query) => query.eq('author_id', trimmed),
    options.limit ?? DEFAULT_LIMIT,
    options.before,
    knownAuthorsById,
  );
}

// ---------------------------------------------------------------------------
// Likes (Phase 3b)
// ---------------------------------------------------------------------------
// All client-direct to `post_likes` / `comment_likes` under RLS (you manage only
// your own like rows). The DB triggers keep `like_count` on posts/comments — the
// client never writes those counters; it updates its own optimistic count and
// reconciles on the next read.

const POST_LIKES_TABLE = 'post_likes';
const COMMENT_LIKES_TABLE = 'comment_likes';
const COMMENTS_TABLE = 'comments';

/**
 * Which of `postIds` the signed-in user has already liked. Powers the filled/empty
 * heart on each card. Returns an empty set on any failure or when unauthenticated —
 * so a like-state read never blocks the feed from rendering.
 */
export async function fetchLikedPostIds(postIds: string[]): Promise<Set<string>> {
  const me = await currentUserId();
  const ids = Array.from(new Set(postIds.filter(Boolean)));
  if (!supabase || !me || ids.length === 0) {
    /*
      An empty set here is INDISTINGUISHABLE from "you have liked nothing", and
      that is the whole problem with this function: every failure mode — no
      session, a permissions error, a network blip — renders as an unliked
      thumb inviting you to like something you already liked. Reported as
      "my likes don't persist", and unreadable from the code because the
      evidence was being thrown away.

      So say when the read did not actually happen. Only the shape of the
      failure is reported (was there a session? how many ids?) — never a post
      id or anything about its content.
    */
    if (supabase && !me && ids.length > 0) {
      capturePostHogEvent('social_like_read_skipped', { reason: 'no_session', idCount: ids.length });
    }
    return new Set();
  }
  try {
    const { data, error } = await supabase
      .from(POST_LIKES_TABLE)
      .select('post_id')
      .eq('user_id', me)
      .in('post_id', ids);
    if (error || !data) {
      capturePostHogEvent('social_like_read_failed', {
        reason: error?.message ?? 'no_data',
        idCount: ids.length,
      });
      return new Set();
    }
    return new Set((data as { post_id: string }[]).map((row) => row.post_id));
  } catch (error) {
    capturePostHogEvent('social_like_read_failed', {
      reason: error instanceof Error ? error.message : 'threw',
      idCount: ids.length,
    });
    return new Set();
  }
}

/**
 * Which of `commentIds` the signed-in user has already liked — the comment-thread
 * equivalent of `fetchLikedPostIds`. Without this a reopened thread shows every
 * comment as unliked, so an already-liked comment invites a second like. Returns
 * an empty set on any failure rather than blocking the thread from rendering.
 */
export async function fetchLikedCommentIds(commentIds: string[]): Promise<Set<string>> {
  const me = await currentUserId();
  const ids = Array.from(new Set(commentIds.filter(Boolean)));
  if (!supabase || !me || ids.length === 0) {
    return new Set();
  }
  try {
    const { data, error } = await supabase
      .from(COMMENT_LIKES_TABLE)
      .select('comment_id')
      .eq('user_id', me)
      .in('comment_id', ids);
    if (error || !data) {
      return new Set();
    }
    return new Set((data as { comment_id: string }[]).map((row) => row.comment_id));
  } catch {
    return new Set();
  }
}

/** Like a post (idempotent). Returns true when the like is in place afterward. */
export async function likePost(postId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !postId) {
    // Reported the same way as the read above, so the two halves of "my likes
    // don't persist" can be told apart: a write that never ran versus a read
    // that never ran.
    if (supabase && !me && postId) {
      capturePostHogEvent('social_like_write_skipped', { reason: 'no_session' });
    }
    return false;
  }
  try {
    const { error } = await supabase
      .from(POST_LIKES_TABLE)
      .upsert({ post_id: postId, user_id: me }, { onConflict: 'post_id,user_id', ignoreDuplicates: true });
    if (error) {
      capturePostHogEvent('social_like_write_failed', { reason: error.message });
    }
    return !error;
  } catch (error) {
    capturePostHogEvent('social_like_write_failed', {
      reason: error instanceof Error ? error.message : 'threw',
    });
    return false;
  }
}

/** Unlike a post. Returns true when the like row is gone afterward. */
export async function unlikePost(postId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !postId) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(POST_LIKES_TABLE)
      .delete()
      .eq('post_id', postId)
      .eq('user_id', me);
    return !error;
  } catch {
    return false;
  }
}

/** Like a comment (idempotent). */
export async function likeComment(commentId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !commentId) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(COMMENT_LIKES_TABLE)
      .upsert({ comment_id: commentId, user_id: me }, { onConflict: 'comment_id,user_id', ignoreDuplicates: true });
    return !error;
  } catch {
    return false;
  }
}

/** Unlike a comment. */
export async function unlikeComment(commentId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !commentId) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(COMMENT_LIKES_TABLE)
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', me);
    return !error;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Comments (Phase 3b)
// ---------------------------------------------------------------------------

const commentSelect =
  'id, post_id, author_id, parent_comment_id, body, like_count, created_at, content_status, deleted_at';

type CommentRow = {
  id: string;
  post_id: string;
  author_id: string;
  parent_comment_id: string | null;
  body: string | null;
  like_count: number | null;
  created_at: string;
  content_status: string | null;
  deleted_at: string | null;
};

export type PostComment = {
  id: string;
  postId: string;
  authorId: string;
  /** Null when the author isn't publicly visible. */
  author: FeedPostAuthor | null;
  /**
   * Always null for a tombstone (`isDeleted`) — the deleted text is never mapped
   * onto the client model, so no renderer can leak what was written.
   */
  body: string | null;
  parentCommentId: string | null;
  likeCount: number;
  createdAt: string;
  /**
   * True when this row is a TOMBSTONE: the comment was deleted but is still in
   * the thread. The sheet renders "This comment was deleted" in place of the body
   * and keeps any replies nested underneath.
   *
   * `fetchComments` always sets this explicitly. It is optional only so a caller
   * building an optimistic comment locally (a comment it just posted — never a
   * tombstone) doesn't have to spell out `isDeleted: false`. Consumers must
   * therefore test `comment.isDeleted === true`, not truthiness of a required flag.
   */
  isDeleted?: boolean;
};

/**
 * Is this row deleted (author soft delete)?
 *
 * `deleted_at` is the authoritative signal and `content_status` is advisory: the
 * async moderation worker writes `content_status = 'removed'` as service_role and
 * can land on a row the author just deleted, clobbering the `'deleted'` sentinel.
 * Either one alone is enough to treat the row as gone.
 */
function isDeletedCommentRow(row: CommentRow): boolean {
  return row.deleted_at != null || row.content_status === 'deleted';
}

/*
  WHY THERE IS NO LONGER A CHILDLESS-TOMBSTONE PRUNE HERE.

  This module used to run `pruneChildlessTombstones` over the fetched rows: a
  deleted comment survived the read only while it still held a live reply up, and
  one with nothing under it was dropped so the reader saw the row simply vanish.
  Two rules, one thread, and which one you got depended on whether somebody had
  happened to answer you. The user's report was "only the first deleted comment
  says 'This comment was deleted'", and that was it — working exactly as
  specified, and specified wrong.

  The rule now is one line: a deleted comment reads as deleted. `comments-sheet.tsx`
  leaves a tombstone for every delete, and this read hands every tombstone it is
  given straight through, so the row a delete leaves behind is still there on the
  next load instead of quietly disappearing under the reader. A tombstone that
  appears on delete and vanishes on reload would be a third behaviour, not a fix.

  WHAT THIS CANNOT DO, and it has to be said plainly: RLS is the ceiling.
  `comments_select` (social_17 §7) returns a deleted row to a NON-author only when
  `comment_has_live_reply(id)` holds. So dropping the client prune makes every
  tombstone visible to its AUTHOR — which is whose thread the report was about,
  and who could otherwise see their own row disappear — while another reader still
  sees a childless deleted comment as absent. Closing that gap means widening the
  policy branch in a migration; no query can retrieve a row the policy refuses.

  Counting is unaffected either way: a tombstone is not a comment anybody wrote,
  the `comment_count` trigger decrements on the `deleted_at` transition regardless
  of replies (social_17 §4), and `visibleCommentCount` in the sheet agrees.
*/

/**
 * Comments for one post, oldest-first (chat order), author-hydrated via
 * `public_profiles`. Threading is carried by `parentCommentId` — the caller nests.
 * Returns `[]` on any failure.
 *
 * DELETED ROWS, and why this query does not filter them out.
 *
 * Soft delete (see `USE_SOFT_DELETE` below) makes a deleted comment survive as a
 * TOMBSTONE — body hidden, replies still attached. The old
 * `.is('deleted_at', null).neq('content_status', 'deleted')` pair cannot express
 * that: it hides EVERY tombstone, which orphans the replies underneath (the sheet
 * promotes a reply whose parent is missing to top level). So the query asks for
 * the whole thread and every row the policy returns is mapped, tombstones
 * included — see the note above on why nothing is pruned here any more.
 *
 * The RLS SELECT policy is authoritative for WHO may see a tombstone: a
 * non-author can only ever receive a deleted row if the policy hands it over.
 * Only `deleted_at` / `content_status` are read to decide that a row IS a
 * tombstone; its `body` is dropped in the mapping below and never reaches a
 * `PostComment`.
 */
export async function fetchComments(postId: string, limit = 100): Promise<PostComment[]> {
  const trimmed = (postId ?? '').trim();
  if (!supabase || !trimmed) {
    return [];
  }
  try {
    const { data, error } = await supabase
      .from(COMMENTS_TABLE)
      .select(commentSelect)
      .eq('post_id', trimmed)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error || !data) {
      return [];
    }

    const rows = data as CommentRow[];
    const authorIds = Array.from(new Set(rows.map((row) => row.author_id).filter(Boolean)));
    const authorsById = new Map<string, FeedPostAuthor>();
    if (authorIds.length > 0) {
      const { data: authorData, error: authorError } = await supabase
        .from(PUBLIC_PROFILES_VIEW)
        .select(postAuthorSelect)
        .in('user_id', authorIds);
      if (!authorError && authorData) {
        for (const row of authorData as PostAuthorRow[]) {
          authorsById.set(row.user_id, mapAuthor(row));
        }
      }
    }

    return rows.map((row) => {
      const deleted = isDeletedCommentRow(row);
      return {
        id: row.id,
        postId: row.post_id,
        authorId: row.author_id,
        author: authorsById.get(row.author_id) ?? null,
        // A tombstone NEVER carries its body forward. Postgres still returns the
        // text (nothing masks the column server-side), so this mapping is the
        // boundary that stops deleted content from reaching any renderer.
        body: deleted ? null : row.body ?? null,
        parentCommentId: row.parent_comment_id ?? null,
        likeCount: row.like_count ?? 0,
        createdAt: row.created_at,
        isDeleted: deleted,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Add a comment (or a reply when `parentCommentId` is set). Returns the created
 * comment id, or null on failure. The in-DB moderation trigger (blocked_terms +
 * rate limit) runs on insert; a rejected insert resolves to null.
 */
/**
 * The outcome of a comment write, INCLUDING why it failed.
 *
 * This used to be `Promise<string | null>`, and that null was the single
 * longest-lived bug in this feature. An RLS rejection, a raising trigger, a
 * dropped connection, an unapplied migration and a signed-out session all
 * collapsed into the same value, and the sheet's only possible response was to
 * keep the draft and do nothing — which is indistinguishable, on the phone, from
 * the send button not working at all. Five rounds of fixes went into the button,
 * the gesture and the keyboard because the write could not be seen to be
 * failing.
 */
export type AddCommentResult =
  | { ok: true; id: string }
  | { ok: false; reason: string };

export async function addComment(
  postId: string,
  body: string,
  parentCommentId?: string | null,
): Promise<AddCommentResult> {
  const text = (body ?? '').trim();
  if (!supabase) {
    return { ok: false, reason: 'Not connected. Check your connection and try again.' };
  }
  const me = await currentUserId();
  if (!me) {
    return { ok: false, reason: 'You are signed out. Sign in to comment.' };
  }
  if (!postId || text.length === 0) {
    return { ok: false, reason: 'Nothing to post.' };
  }
  try {
    const { data, error } = await supabase
      .from(COMMENTS_TABLE)
      .insert({
        post_id: postId,
        author_id: me,
        body: text,
        parent_comment_id: parentCommentId ?? null,
      })
      .select('id')
      .single();
    if (error) {
      // The REAL message, not a generic one. A Postgres error here names its
      // own cause ("new row violates row-level security policy for table
      // comments", "function public.is_admin() does not exist", …), and that
      // string is the difference between fixing this and guessing at it again.
      return { ok: false, reason: error.message || 'The comment could not be saved.' };
    }
    if (!data) {
      // Insert accepted, row not returned: `.select()` reads back through the
      // SELECT policy, so this is the shape a policy mismatch takes.
      return { ok: false, reason: 'Saved, but could not be read back. Pull to refresh.' };
    }
    return { ok: true, id: (data as { id: string }).id };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'The comment could not be saved.',
    };
  }
}

// ---------------------------------------------------------------------------
// Compose (Phase 3c)
// ---------------------------------------------------------------------------

/**
 * Create a text/card post authored by the signed-in user. Returns the new post id,
 * or null on failure (unauthenticated, empty body with no card, moderation reject).
 * Image attachment is a separate step: the composer uploads each image to the
 * backend post-media endpoint with this post id. `content_status` defaults to
 * visible; the in-DB moderation trigger runs on insert.
 */
export async function createPost(input: { body?: string | null; cardId?: string | null }): Promise<string | null> {
  const me = await currentUserId();
  const body = (input.body ?? '').trim();
  const cardId = (input.cardId ?? '').trim() || null;
  if (!supabase || !me || (body.length === 0 && !cardId)) {
    return null;
  }
  try {
    const { data, error } = await supabase
      .from(POSTS_TABLE)
      .insert({ author_id: me, body: body.length > 0 ? body : null, card_id: cardId })
      .select('id')
      .single();
    if (error || !data) {
      return null;
    }
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deleting your own content
// ---------------------------------------------------------------------------
// Authorization is NOT done here. `posts_delete` / `comments_delete` (social_01)
// already scope deletes to `author_id = auth.uid() or public.is_admin()`, so this
// module deliberately does NOT add an `author_id = me` filter: that would both
// duplicate the policy and break an admin moderation delete, which is a legitimate
// delete of someone else's row.
//
// The catch is that RLS refuses SILENTLY, and it does so identically for the
// UPDATE that soft delete really is: an `update(...).eq('id', id)` on a row you
// may not touch matches zero rows and comes back 204/no-error — indistinguishable
// from a successful delete. So every mutation here asks for the affected rows back
// with `.select('id')` (PostgREST `Prefer: return=representation`, the same trick
// `addComment` / `createPost` use on insert) and treats an empty array as failure.
// Without that, this function would report success while changing nothing and the
// caller's optimistic row removal would silently lie to the user.

/**
 * Hard delete (`delete from`) vs soft delete (`content_status`/`deleted_at`).
 *
 * DECIDED: SOFT delete. The write is an UPDATE that sets
 * `deleted_at = now()` and `content_status = 'deleted'`; the row stays in the
 * table, addressable by an open report's `reports.target_id` (a bare uuid with no
 * FK, so a hard delete would leave a moderator a report they cannot judge), and
 * the `notifications` rows other people have already received and read are left
 * intact instead of being cascaded away underneath them.
 *
 * `'deleted'` is the sentinel, NOT the `'removed'` in social_01's column comment.
 * `'removed'` belongs to the async moderation worker
 * (`backend/social_moderation_worker.py`, writing as service_role), and it is the
 * value this file's reads have always filtered on. Because the worker can land on
 * a row the author just deleted and overwrite the sentinel, `deleted_at` — not
 * `content_status` — is the authoritative "this is gone" signal everywhere in
 * this module (see `isDeletedCommentRow`).
 *
 * Three things the migration must provide, or this silently breaks:
 *   1. `posts_select` / `comments_select` must let the AUTHOR read their own
 *      soft-deleted rows. Postgres applies the SELECT policy to an UPDATE's
 *      RETURNING rows, so with `deleted_at is null` as an unconditional conjunct
 *      the soft-delete write fails its own `.select('id')` and a delete that
 *      actually succeeded reports failure — the UI then un-hides the row.
 *   2. The `post_count` / `comment_count` triggers must decrement on the
 *      visible -> deleted UPDATE (they were INSERT/DELETE-only), and must not
 *      decrement twice when an already soft-deleted row is later hard-deleted.
 *   3. Tombstone visibility for OTHER readers: a deleted comment that still has
 *      replies has to remain selectable by non-authors, or its replies get
 *      promoted to top level in the sheet. See `fetchComments` — the client
 *      prunes childless tombstones either way, but it cannot conjure a row the
 *      policy refuses to return.
 */
const USE_SOFT_DELETE: boolean = true;

/** Tables this module is allowed to delete from. */
type DeletableTable = typeof POSTS_TABLE | typeof COMMENTS_TABLE;

/**
 * Delete one row by id and report whether a row was ACTUALLY affected. Returns
 * false for every failure mode — no Supabase client, unauthenticated, blank id, a
 * rejected query, and (the one that matters) an RLS-refused write that affected
 * zero rows. Never throws.
 *
 * The soft-delete UPDATE is deliberately NOT scoped to `deleted_at is null`.
 * Deleting an already-deleted row rewrites the timestamp and reports true, which
 * is the right answer to "is this gone" — and the counter trigger only fires on a
 * real null -> not-null transition, so it cannot double-decrement. Adding the
 * guard would instead make a double tap look like a failed delete.
 */
async function deleteOwnedRow(table: DeletableTable, id: string): Promise<boolean> {
  const me = await currentUserId();
  const trimmed = (id ?? '').trim();
  if (!supabase || !me || !trimmed) {
    return false;
  }
  try {
    // Cast for the same reason as `PostFilter` above: threading PostgREST's
    // builder generics through a table-name union trips tsc's instantiation
    // depth. The runtime shape is checked below.
    const from = supabase.from(table) as any;
    const mutation = USE_SOFT_DELETE
      ? from
          .update({ content_status: 'deleted', deleted_at: new Date().toISOString() })
          .eq('id', trimmed)
      : from.delete().eq('id', trimmed);

    const { data, error } = (await mutation.select('id')) as {
      data: { id: string }[] | null;
      error: unknown;
    };
    if (error) {
      return false;
    }
    // Zero rows back = RLS refused (or the row is already gone). Either way the
    // caller must not treat it as a delete it can render optimistically. Under
    // soft delete this is also what catches a policy that forgot to let the
    // author read their own tombstone: the UPDATE lands, the RETURNING comes back
    // empty, and this reports false rather than a phantom success.
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Delete one of your own posts. True only when a row was really affected; false
 * when RLS refused (not the author) or the query failed.
 *
 * A soft-deleted post simply disappears — there is no tombstone for posts. Its
 * comments are deliberately NOT cascaded: nothing can reach them once the post is
 * invisible, and keeping the subtree is the moderation history soft delete exists
 * for.
 */
export async function deletePost(postId: string): Promise<boolean> {
  return deleteOwnedRow(POSTS_TABLE, postId);
}

/**
 * Delete one of your own comments. Same contract as `deletePost`, with one
 * difference the UI has to render: the comment survives as a TOMBSTONE
 * (`isDeleted`, body dropped) so its replies stay nested and the thread says the
 * same thing about every deleted comment. `fetchComments` hands every tombstone
 * the policy returns through; RLS decides which readers get one.
 */
export async function deleteComment(commentId: string): Promise<boolean> {
  return deleteOwnedRow(COMMENTS_TABLE, commentId);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
// Rows are written server-side by the `social_11` triggers (a like/comment/follow
// inserts one in the same transaction). The client only ever READS and marks
// read: `notifications` has a select and an update policy scoped to the
// recipient, and deliberately NO insert policy — so nothing here writes a row.
//
// Polling, not Realtime, on purpose. These queries go client-direct to Supabase
// and never touch the backend VM, so a foreground poll costs zero VM CPU — the
// resource that actually constrains this app. The unread count is a covered read
// against `idx_notifications_unread`, a partial index on `read_at is null`.

const NOTIFICATIONS_TABLE = 'notifications';

/** Types the app renders. `mention`/`message` exist in the schema but nothing
 *  produces them yet (no parser, no DMs), so they are not surfaced. */
export type NotificationType = 'like' | 'comment' | 'follow';

export type AppNotification = {
  id: string;
  type: NotificationType;
  actor: FeedPostAuthor | null;
  postId: string | null;
  commentId: string | null;
  createdAt: string;
  readAt: string | null;
  /**
   * What was actually said. A notification that only reports that someone
   * commented makes you open the thread to find out whether it needs an answer;
   * carrying the words means the list is readable on its own.
   */
  commentBody: string | null;
  /** The comment is a REPLY (it has a parent) rather than a top-level comment. */
  isReply: boolean;
  /**
   * Who owns the post this points at, for "on <handle>'s post". Null when the
   * post is the recipient's own — the copy then says "your post" instead.
   */
  postAuthor: FeedPostAuthor | null;
  /** First image on that post, for the row's thumbnail. Null on text posts. */
  postMediaId: string | null;
};

type NotificationRow = {
  id: string;
  type: string;
  actor_id: string | null;
  post_id: string | null;
  comment_id: string | null;
  created_at: string;
  read_at: string | null;
};

const RENDERABLE_NOTIFICATION_TYPES: readonly string[] = ['like', 'comment', 'follow'];

/**
 * How many unread notifications the signed-in user has — the number on the bell.
 *
 * Uses a `head: true` count so Postgres answers from the partial unread index
 * without materializing any rows; the badge cost stays flat as history grows.
 * Returns 0 on any failure: a badge that silently shows nothing is much better
 * than one that blocks the Collection header from rendering.
 */
export async function fetchUnreadNotificationCount(): Promise<number> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return 0;
  }
  try {
    const { count, error } = await supabase
      .from(NOTIFICATIONS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', me)
      .is('read_at', null);
    return error ? 0 : (count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The notification list, newest first, with actors hydrated from
 * `public_profiles` in ONE follow-up query rather than per row.
 *
 * Unknown `type` values are filtered out rather than rendered as a blank row —
 * the schema allows `mention`/`message`, and a future migration could add more.
 */
export async function fetchNotifications(limit = 50): Promise<AppNotification[]> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return [];
  }
  try {
    const { data, error } = await supabase
      .from(NOTIFICATIONS_TABLE)
      .select('id, type, actor_id, post_id, comment_id, created_at, read_at')
      .eq('recipient_id', me)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) {
      return [];
    }

    const rows = (data as NotificationRow[]).filter((row) =>
      RENDERABLE_NOTIFICATION_TYPES.includes(row.type),
    );
    if (rows.length === 0) {
      return [];
    }

    /*
      Hydrate the context the row needs, BATCHED — three `in(...)` reads for the
      whole page, never per row:

        comments -> the words that were said, and whether it was a reply
        posts    -> who owns the post, and its first image for the thumbnail
        profiles -> display identity for actors AND post owners, in ONE query

      Every one of these is allowed to come back empty. A notification is a real
      event regardless of whether its context resolves, so a failed hydration
      degrades the row to the plain "X commented on your post" it was before
      rather than dropping it.
    */
    const commentIds = Array.from(
      new Set(rows.map((row) => row.comment_id).filter((id): id is string => Boolean(id))),
    );
    const commentsById = new Map<string, { postId: string | null; parentId: string | null; body: string | null }>();
    if (commentIds.length > 0) {
      const { data: comments } = await supabase
        .from(COMMENTS_TABLE)
        .select('id, post_id, parent_comment_id, body, deleted_at')
        .in('id', commentIds);
      for (const row of (comments ?? []) as (CommentRow & { deleted_at: string | null })[]) {
        commentsById.set(row.id, {
          postId: row.post_id ?? null,
          parentId: row.parent_comment_id ?? null,
          // A deleted comment keeps its notification but must not keep showing
          // its words — the tombstone rule from the thread applies here too.
          body: row.deleted_at ? null : row.body,
        });
      }
    }

    // A comment notification carries `comment_id`; the post it belongs to comes
    // from the comment, so both sources feed the post lookup.
    const postIds = Array.from(
      new Set(
        rows
          .map((row) => row.post_id ?? commentsById.get(row.comment_id ?? '')?.postId ?? null)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const postsById = new Map<string, { authorId: string; mediaId: string | null }>();
    if (postIds.length > 0) {
      const { data: posts } = await supabase
        .from(POSTS_TABLE)
        .select(`id, author_id, ${POST_MEDIA_TABLE}(id, position)`)
        .in('id', postIds);
      for (const row of (posts ?? []) as PostRow[]) {
        const media = [...(row.post_media ?? [])].sort(
          (left, right) => (left.position ?? 0) - (right.position ?? 0),
        );
        postsById.set(row.id, { authorId: row.author_id, mediaId: media[0]?.id ?? null });
      }
    }

    const actorIds = rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id));
    const postAuthorIds = Array.from(postsById.values()).map((post) => post.authorId);
    const profileIds = Array.from(new Set([...actorIds, ...postAuthorIds]));
    const actorsById = new Map<string, FeedPostAuthor>();
    if (profileIds.length > 0) {
      const { data: profiles } = await supabase
        .from(PUBLIC_PROFILES_VIEW)
        .select(postAuthorSelect)
        .in('user_id', profileIds);
      for (const profile of (profiles ?? []) as PostAuthorRow[]) {
        actorsById.set(profile.user_id, mapAuthor(profile));
      }
    }

    return rows.map((row) => {
      const comment = row.comment_id ? commentsById.get(row.comment_id) ?? null : null;
      const postId = row.post_id ?? comment?.postId ?? null;
      const post = postId ? postsById.get(postId) ?? null : null;
      // Your own post says "your post", so there is no name to resolve.
      const postAuthor =
        post && post.authorId !== me ? actorsById.get(post.authorId) ?? null : null;

      return {
        id: row.id,
        type: row.type as NotificationType,
        // An actor whose account was deleted leaves a null FK — the notification
        // is still real, so render it rather than dropping it.
        actor: row.actor_id ? actorsById.get(row.actor_id) ?? null : null,
        postId,
        commentId: row.comment_id,
        createdAt: row.created_at,
        readAt: row.read_at,
        commentBody: comment?.body ?? null,
        isReply: Boolean(comment?.parentId),
        postAuthor,
        postMediaId: post?.mediaId ?? null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Mark every unread notification read. Called when the list opens, so the badge
 * clears on view — the same model as the rest of the app's read state.
 *
 * Scoped to `read_at is null` so it only ever touches unread rows: re-opening the
 * list can't rewrite timestamps on history you already saw.
 */
export async function markAllNotificationsRead(): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(NOTIFICATIONS_TABLE)
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', me)
      .is('read_at', null);
    return !error;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Blocking and reporting
// ---------------------------------------------------------------------------
// This is the ONLY safety mechanism standing behind DMs. `messages.content_status`
// is a cheap wordlist/rate-limit gate (social_04) and nothing else: DMs are
// private, so `backend/social_moderation_worker.py` deliberately never reads them.
// There is no AI pass on a DM. If a user is being harassed in their inbox, block
// and report is the whole answer — which is why these four functions exist before
// the DM surface ships, not after.
//
// Both tables have been in the schema since day one and were never wired up:
// `blocks` since social_00, `reports` since social_04.
//
// WHAT BLOCKING ACTUALLY DOES TODAY (be precise about this — it is uneven):
//   `public.is_blocked(a, b)` is EITHER-DIRECTION and is baked into the RLS
//   select policies for `posts`, `post_media`, and `comments`, plus the insert
//   policies for `follows` and `post_likes`. So a block instantly and mutually
//   removes feed posts, post images, and comment threads for BOTH parties, with
//   no client-side filtering needed — the rows never leave Postgres.
//
//   DMs are PARTLY covered, and the split matters: social_13 added
//   `conversation_has_block` to `messages_insert` (and social_19 to
//   `messages_update`), so a blocked thread is FROZEN — neither party can send,
//   because the gate is either-direction. But `messages_select`,
//   `conversations_select` and `conv_participants_select` are deliberately
//   untouched: the history stays readable so a victim can still open the thread
//   and report what was said. The conversation therefore stays in both inboxes.
//
//   It does NOT cover `conversations` / `conversation_participants` SELECT (see
//   above). `public_profiles` and `follows` SELECT are covered ON STAGING, where
//   social_19 IS applied (staging is at social_20 as of 2026-08-09 — verified by
//   `supabase db push --dry-run --linked`, NOT by any prose). Production was not
//   re-checked and may still predate it, in which case those two are unfiltered
//   there. Where RLS does not filter for you, `fetchBlockedUserIds` is how a
//   surface filters for itself.

const BLOCKS_TABLE = 'blocks';
const REPORTS_TABLE = 'reports';

/** Report targets, matching the `reports.target_type` values social_04 defines. */
type ReportTargetType = 'post' | 'comment' | 'message' | 'profile';

export type ReportContentInput = {
  /** The account being reported. Also the target when no content id is given. */
  reportedUserId: string;
  postId?: string | null;
  commentId?: string | null;
  messageId?: string | null;
  reason: string;
};

/**
 * Block a user. Idempotent — blocking someone you already blocked is a no-op that
 * still returns true, because "am I protected from this person" is the question
 * the caller is really asking, and the answer is yes either way. Modelled on
 * `likePost`: upsert with `ignoreDuplicates` so a double tap can't surface a
 * primary-key error as a failed block.
 *
 * Self-blocks are rejected here rather than at the DB, where the
 * `check (blocker_id <> blocked_id)` constraint would come back as an opaque 23514.
 */
export async function blockUser(userId: string): Promise<boolean> {
  const me = await currentUserId();
  const target = (userId ?? '').trim();
  if (!supabase || !me || !target || target === me) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(BLOCKS_TABLE)
      .upsert(
        { blocker_id: me, blocked_id: target },
        { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true },
      );
    return !error;
  } catch {
    return false;
  }
}

/**
 * Lift a block. Also idempotent: unblocking someone who was never blocked deletes
 * zero rows and reports success.
 *
 * Scoped to `blocker_id = me` on the client as well as in RLS — the `blocks_all`
 * policy would reject anything else, but an unscoped delete is not a mistake worth
 * leaving one policy away from a data loss.
 */
export async function unblockUser(userId: string): Promise<boolean> {
  const me = await currentUserId();
  const target = (userId ?? '').trim();
  if (!supabase || !me || !target) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(BLOCKS_TABLE)
      .delete()
      .eq('blocker_id', me)
      .eq('blocked_id', target);
    return !error;
  } catch {
    return false;
  }
}

/**
 * The ids the signed-in user has blocked — outgoing blocks only. `blocks_all`
 * scopes every operation to `blocker_id = auth.uid()`, so this can never reveal
 * who has blocked YOU, and it must not try: a block the blocked party can detect
 * is an invitation to retaliate under a second account.
 *
 * Same empty-set-on-failure contract as `fetchLikedPostIds`, but the failure mode
 * is worse here, so callers must treat this as a presentation filter only. RLS is
 * what actually enforces a block on posts and comments; this set exists for the
 * surfaces RLS does not cover yet (DM threads, follower lists, profile headers).
 * A surface that has no server-side block enforcement must never rely on this
 * read alone to keep a blocked user out.
 */
export async function fetchBlockedUserIds(): Promise<Set<string>> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return new Set();
  }
  try {
    const { data, error } = await supabase
      .from(BLOCKS_TABLE)
      .select('blocked_id')
      .eq('blocker_id', me);
    if (error || !data) {
      return new Set();
    }
    return new Set(
      (data as { blocked_id: string | null }[])
        .map((row) => row.blocked_id)
        .filter((id): id is string => Boolean(id)),
    );
  } catch {
    return new Set();
  }
}

/** One row of the "Blocked accounts" list: enough to recognise a person. */
export type BlockedProfile = {
  userID: string;
  displayName: string | null;
  handle: string | null;
  avatarURL: string | null;
};

/** SECURITY DEFINER escape hatch added by social_19. Takes no argument. */
const BLOCKED_PROFILES_RPC = 'blocked_profiles';

type BlockedProfileRow = {
  user_id: string;
  display_name: string | null;
  handle: string | null;
  avatar_url: string | null;
};

function mapBlockedProfile(row: BlockedProfileRow): BlockedProfile {
  return {
    userID: row.user_id,
    displayName: row.display_name,
    handle: row.handle ?? null,
    avatarURL: row.avatar_url ?? null,
  };
}

/**
 * The people the signed-in user has blocked, newest block first — the read
 * behind the unblock list. Ids alone are useless in a UI, so this resolves each
 * one to a name/handle/avatar.
 *
 * TWO LANES, because the right one depends on which migration the environment
 * has run, and the wrong one leaves the user staring at a screen of UUIDs:
 *
 *   1. `blocked_profiles()` (social_19). THIS IS THE LIVE LANE on staging, which
 *      is at social_20. social_19 makes `public_profiles` filter on
 *      `is_blocked(auth.uid(), user_id)` — which is EITHER-direction — so the
 *      blocker can no longer read their own blocked users through the view. The
 *      RPC is the only lane that still can. It is not a lookup tool: it takes no
 *      argument, pins the caller to `auth.uid()` internally, and returns strictly
 *      rows where the CALLER is the blocker.
 *
 *   2. `blocks` + `public_profiles` hydration, for an environment still behind
 *      social_19 — production, which was not re-checked on 2026-08-09. There the
 *      view still returns blocked users, so this resolves names fine. A strict
 *      fallback, taken ONLY on `PGRST202`/`42883` — any other RPC failure means
 *      the function is there and a second read would be wrong.
 *
 *   Do not re-derive which lane is live from a migration header or README: those
 *   have been stale three separate times in this schema's history. Run
 *   `supabase db push --dry-run --linked`.
 *
 * A block whose profile cannot be resolved on either lane is still RETURNED,
 * with a null `displayName`. Dropping it would be the worse bug: the row would
 * vanish from the only screen that can lift it, and the block would be
 * permanent. The screen renders those as "Blocked account" and the Unblock
 * button still works, because unblocking only needs the id.
 *
 * Never throws — resolves to `[]` on any failure, like every read in this file.
 */
export async function fetchBlockedProfiles(): Promise<BlockedProfile[]> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return [];
  }

  if (typeof supabase.rpc === 'function') {
    let missingRpc = false;
    try {
      const { data, error } = await supabase.rpc(BLOCKED_PROFILES_RPC);
      if (!error && Array.isArray(data)) {
        return (data as BlockedProfileRow[])
          .filter((row) => Boolean(row?.user_id))
          .map(mapBlockedProfile);
      }
      missingRpc = isMissingFunctionError(error);
    } catch {
      return [];
    }
    if (!missingRpc) {
      return [];
    }
  }

  // Fallback lane: read the block edges in order, then hydrate what the view
  // will still give us.
  try {
    const { data, error } = await supabase
      .from(BLOCKS_TABLE)
      .select('blocked_id, created_at')
      .eq('blocker_id', me)
      .order('created_at', { ascending: false });
    if (error || !data) {
      return [];
    }

    const ids = (data as { blocked_id: string | null }[])
      .map((row) => row.blocked_id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      return [];
    }

    const profiles = new Map<string, BlockedProfile>();
    const { data: profileRows, error: profileError } = await supabase
      .from(PUBLIC_PROFILES_VIEW)
      .select('user_id, display_name, handle, avatar_url')
      .in('user_id', ids);
    if (!profileError && profileRows) {
      for (const row of profileRows as BlockedProfileRow[]) {
        profiles.set(row.user_id, mapBlockedProfile(row));
      }
    }

    // Block order wins; the hydration is only there to put a name on each row.
    return ids.map(
      (userID) =>
        profiles.get(userID) ?? { userID, displayName: null, handle: null, avatarURL: null },
    );
  } catch {
    return [];
  }
}

/**
 * File a report against a user or one piece of their content.
 *
 * `reports` is polymorphic (`target_type` + `target_id`), so the caller's optional
 * ids collapse to the MOST SPECIFIC one present: message, then comment, then post,
 * falling back to the account itself. Reporting the exact message beats reporting
 * the sender, because a moderator reading the queue needs the thing that was said.
 *
 * Reporting is NOT blocking. Nothing here hides anything from the reporter — the
 * social_04 threshold trigger only hides a post/comment once THREE distinct
 * reporters flag it, and it has no branch for messages at all. A UI that offers
 * "report" must offer "block" alongside it or the user is left still seeing the
 * content they just reported.
 *
 * Idempotent via `unique (reporter_id, target_type, target_id)`: re-reporting the
 * same target returns true instead of a duplicate-key failure. `ignoreDuplicates`
 * matters beyond ergonomics — it compiles to `on conflict do nothing`, whereas an
 * updating upsert would need a SELECT back, and social_04 gives non-admins insert
 * only. A report is deliberately write-only; the reporter can never read the queue.
 */
export async function reportContent(input: ReportContentInput): Promise<boolean> {
  const me = await currentUserId();
  const reportedUserId = (input.reportedUserId ?? '').trim();
  const postId = (input.postId ?? '').trim();
  const commentId = (input.commentId ?? '').trim();
  const messageId = (input.messageId ?? '').trim();
  const reason = (input.reason ?? '').trim();

  let targetType: ReportTargetType = 'profile';
  let targetId = reportedUserId;
  if (messageId) {
    targetType = 'message';
    targetId = messageId;
  } else if (commentId) {
    targetType = 'comment';
    targetId = commentId;
  } else if (postId) {
    targetType = 'post';
    targetId = postId;
  }

  if (!supabase || !me || !targetId) {
    return false;
  }

  try {
    // A PLAIN INSERT, not an upsert — and the difference is load-bearing.
    //
    // This used to be `.upsert(..., { ignoreDuplicates: true })`, on the
    // reasoning that it compiles to `on conflict do nothing` and so needs only
    // the INSERT privilege. In practice every report failed with "Couldn't send
    // report": PostgREST's upsert path also requires UPDATE on the table, and
    // social_04 grants non-admins INSERT ONLY (`reports_insert`), keeping
    // `reports_admin_update` and `reports_admin_select` admin-gated so a
    // reporter can never read or rewrite the moderator queue. The upsert was
    // therefore asking for a privilege the threat model deliberately withholds.
    //
    // `blocks` hid this: social_00's `blocks_all` is a `for all` policy, so the
    // identical upsert shape works there. Two tables, one pattern, and only the
    // one with the tighter policy broke.
    //
    // So: insert, and treat the unique violation as success. Re-reporting the
    // same target is a no-op either way — social_04's
    // `unique (reporter_id, target_type, target_id)` is what makes the
    // three-distinct-reporter threshold mean three PEOPLE — and telling someone
    // "you already reported this" only invites them to report harder.
    const { error } = await supabase.from(REPORTS_TABLE).insert({
      reporter_id: me,
      target_type: targetType,
      target_id: targetId,
      // `reason` is nullable in social_04; an empty box stays null rather than
      // filling the moderator queue with blank strings.
      reason: reason.length > 0 ? reason : null,
    });

    if (!error) {
      return true;
    }
    // 23505 = unique_violation: already reported by this user. Idempotent success.
    if (error.code === '23505') {
      return true;
    }
    // Anything else is a real failure, and it must not vanish. Swallowing the
    // PostgREST error is what made the bug above invisible: the UI said "please
    // try again in a moment" for a permission error that no amount of retrying
    // could fix, and there was nothing anywhere to say so.
    console.warn(
      `[social] report failed target_type=${targetType} code=${error.code ?? 'none'} message=${error.message}`,
    );
    return false;
  } catch (error) {
    console.warn('[social] report threw', error);
    return false;
  }
}
