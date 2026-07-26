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

/** The signed-in user's id, or null when unauthenticated / Supabase absent. */
async function currentUserId(): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  try {
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

/**
 * Turn base post rows into normalized `FeedPost[]`, hydrating author identity via
 * `public_profiles` and media via `post_media`. Preserves the incoming post order
 * (the caller sorts newest-first). Returns `[]` on any failure.
 */
async function hydratePosts(rows: PostRow[]): Promise<FeedPost[]> {
  if (!supabase || rows.length === 0) {
    return [];
  }

  const authorIds = Array.from(new Set(rows.map((row) => row.author_id).filter(Boolean)));
  const postIds = rows.map((row) => row.id);

  const authorsById = new Map<string, FeedPostAuthor>();
  const mediaByPost = new Map<string, FeedPostMedia[]>();

  try {
    const [authorResult, mediaResult] = await Promise.all([
      authorIds.length > 0
        ? supabase.from(PUBLIC_PROFILES_VIEW).select(postAuthorSelect).in('user_id', authorIds)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from(POST_MEDIA_TABLE)
        .select(postMediaSelect)
        .in('post_id', postIds)
        .order('position', { ascending: true }),
    ]);

    if (!authorResult.error && authorResult.data) {
      for (const row of authorResult.data as PostAuthorRow[]) {
        authorsById.set(row.user_id, mapAuthor(row));
      }
    }

    // A media read failure just yields text-only posts rather than dropping them.
    if (!mediaResult.error && mediaResult.data) {
      for (const row of mediaResult.data as PostMediaRow[]) {
        const list = mediaByPost.get(row.post_id) ?? [];
        list.push({
          id: row.id,
          width: row.width ?? null,
          height: row.height ?? null,
          blurhash: row.blurhash ?? null,
        });
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
): Promise<FeedPost[]> {
  if (!supabase) {
    return [];
  }

  try {
    let query = supabase
      .from(POSTS_TABLE)
      .select(postSelect)
      // Belt-and-braces on top of RLS: never surface a soft-deleted post.
      .is('deleted_at', null)
      .neq('content_status', 'deleted');

    query = applyFilter(query);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      return [];
    }

    return hydratePosts(data as PostRow[]);
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

/** Posts by one author, newest first — the profile Activity tab. */
export function fetchAuthorPosts(authorId: string, limit = DEFAULT_LIMIT, before?: string): Promise<FeedPost[]> {
  const trimmed = (authorId ?? '').trim();
  if (!trimmed) {
    return Promise.resolve([]);
  }
  return fetchPosts((query) => query.eq('author_id', trimmed), limit, before);
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
