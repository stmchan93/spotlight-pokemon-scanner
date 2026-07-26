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
