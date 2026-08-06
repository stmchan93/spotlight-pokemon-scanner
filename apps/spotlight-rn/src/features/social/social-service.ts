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
