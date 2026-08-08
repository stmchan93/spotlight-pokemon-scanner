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
      // Belt-and-braces on top of RLS: never surface a soft-deleted post.
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
    return new Set();
  }
  try {
    const { data, error } = await supabase
      .from(POST_LIKES_TABLE)
      .select('post_id')
      .eq('user_id', me)
      .in('post_id', ids);
    if (error || !data) {
      return new Set();
    }
    return new Set((data as { post_id: string }[]).map((row) => row.post_id));
  } catch {
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
    return false;
  }
  try {
    const { error } = await supabase
      .from(POST_LIKES_TABLE)
      .upsert({ post_id: postId, user_id: me }, { onConflict: 'post_id,user_id', ignoreDuplicates: true });
    return !error;
  } catch {
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
  body: string | null;
  parentCommentId: string | null;
  likeCount: number;
  createdAt: string;
};

/**
 * Comments for one post, oldest-first (chat order), author-hydrated via
 * `public_profiles`. Threading is carried by `parentCommentId` — the caller nests.
 * Returns `[]` on any failure. Soft-deleted rows are excluded.
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
      .is('deleted_at', null)
      .neq('content_status', 'deleted')
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

    return rows.map((row) => ({
      id: row.id,
      postId: row.post_id,
      authorId: row.author_id,
      author: authorsById.get(row.author_id) ?? null,
      body: row.body ?? null,
      parentCommentId: row.parent_comment_id ?? null,
      likeCount: row.like_count ?? 0,
      createdAt: row.created_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Add a comment (or a reply when `parentCommentId` is set). Returns the created
 * comment id, or null on failure. The in-DB moderation trigger (blocked_terms +
 * rate limit) runs on insert; a rejected insert resolves to null.
 */
export async function addComment(
  postId: string,
  body: string,
  parentCommentId?: string | null,
): Promise<string | null> {
  const me = await currentUserId();
  const text = (body ?? '').trim();
  if (!supabase || !me || !postId || text.length === 0) {
    return null;
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
    if (error || !data) {
      return null;
    }
    return (data as { id: string }).id;
  } catch {
    return null;
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
// The catch is that RLS refuses SILENTLY. A `delete().eq('id', id)` on a row you
// may not delete matches zero rows and comes back 204/no-error — indistinguishable
// from a successful delete. So every mutation here asks for the affected rows back
// with `.select('id')` (PostgREST `Prefer: return=representation`, the same trick
// `addComment` / `createPost` use on insert) and treats an empty array as failure.
// Without that, this function would report success while deleting nothing and the
// caller's optimistic row removal would silently lie to the user.

/**
 * Hard delete (`delete from`) vs soft delete (`content_status`/`deleted_at`).
 *
 * ASSUMED: HARD delete. It is what the shipped policies already allow, and the
 * FK cascades do the cleanup for free — `post_media`, `comments`,
 * `post_likes`/`comment_likes` and the `notifications` rows all cascade off
 * `posts.id` / `comments.id`, and the `post_count` / `comment_count` triggers fire
 * on DELETE (not on an UPDATE that sets `deleted_at`), so counters stay correct.
 *
 * Flip this ONE constant if the migration lands on soft delete instead. Two things
 * the migration must then also provide, or the switch silently breaks:
 *   1. `posts_select` / `comments_select` both start with `deleted_at is null`.
 *      Postgres applies the SELECT policy to an UPDATE's RETURNING rows, so the
 *      soft-delete write would fail its own `.select('id')` — the author must be
 *      allowed to see their own soft-deleted rows.
 *   2. The `post_count` / `comment_count` triggers must learn to decrement on a
 *      visible -> deleted transition.
 * `'deleted'` is the sentinel the reads in this file already filter on
 * (`.neq('content_status', 'deleted')`), not the `removed` in social_01's column
 * comment, so keep the migration's value in step with those reads.
 */
const USE_SOFT_DELETE: boolean = false;

/** Tables this module is allowed to delete from. */
type DeletableTable = typeof POSTS_TABLE | typeof COMMENTS_TABLE;

/**
 * Delete one row by id and report whether a row was ACTUALLY removed. Returns
 * false for every failure mode — no Supabase client, unauthenticated, blank id, a
 * rejected query, and (the one that matters) an RLS-refused delete that affected
 * zero rows. Never throws.
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
    // caller must not treat it as a delete it can render optimistically.
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Delete one of your own posts. True only when a row was really removed; false
 * when RLS refused (not the author), the row was already gone, or the query failed.
 */
export async function deletePost(postId: string): Promise<boolean> {
  return deleteOwnedRow(POSTS_TABLE, postId);
}

/**
 * Delete one of your own comments. Same contract as `deletePost`. Replies cascade
 * off `comments.parent_comment_id`, and the `comment_count` trigger decrements the
 * parent post.
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

    const actorIds = Array.from(
      new Set(rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id))),
    );
    const actorsById = new Map<string, FeedPostAuthor>();
    if (actorIds.length > 0) {
      const { data: profiles } = await supabase
        .from(PUBLIC_PROFILES_VIEW)
        .select(postAuthorSelect)
        .in('user_id', actorIds);
      for (const profile of (profiles ?? []) as PostAuthorRow[]) {
        actorsById.set(profile.user_id, mapAuthor(profile));
      }
    }

    return rows.map((row) => ({
      id: row.id,
      type: row.type as NotificationType,
      // An actor whose account was deleted leaves a null FK — the notification
      // is still real, so render it rather than dropping it.
      actor: row.actor_id ? actorsById.get(row.actor_id) ?? null : null,
      postId: row.post_id,
      commentId: row.comment_id,
      createdAt: row.created_at,
      readAt: row.read_at,
    }));
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
//   It does NOT cover `messages` / `conversations` / `conversation_participants`
//   (social_02 policies check participation only), the `public_profiles` view
//   (social_07 filters on `status` / `is_shadowbanned`, not blocks), or
//   `follows` SELECT (`using (true)`). A blocked user can therefore still open a
//   DM thread and still be listed in a follower list. Closing those gaps is a
//   migration, not a client change; until then `fetchBlockedUserIds` is how a
//   surface that reads those tables filters for itself.

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
    const { error } = await supabase.from(REPORTS_TABLE).upsert(
      {
        reporter_id: me,
        target_type: targetType,
        target_id: targetId,
        // `reason` is nullable in social_04; an empty box stays null rather than
        // filling the moderator queue with blank strings.
        reason: reason.length > 0 ? reason : null,
      },
      { onConflict: 'reporter_id,target_type,target_id', ignoreDuplicates: true },
    );
    return !error;
  } catch {
    return false;
  }
}
