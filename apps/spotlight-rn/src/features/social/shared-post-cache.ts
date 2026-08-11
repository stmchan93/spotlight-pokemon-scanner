import { type FeedPost, fetchPostById } from '@/features/social/social-service';

/*
  ─────────────────────────────────────────────────────────────────────────────
  WHAT THIS CACHE IS FOR — AND THE ONE THING IT MUST NOT DO
  ─────────────────────────────────────────────────────────────────────────────
  A shared post in a DM is stored as an id and hydrated on every read, so
  `posts_select` re-answers "may this reader see it?" each time (social_22). That
  is deliberate: a post removed by moderation, soft-deleted, or hidden by a block
  created since it was sent has to stop resolving.

  So this cache MUST NOT skip the read. It exists only to remove the BLANK FRAME
  before the read returns: a reopened thread paints the card it already showed,
  then the fetch runs anyway and corrects it. Stale-while-revalidate, exactly as
  `shared-profile-bubble.tsx` does it — never read-instead-of-revalidate.

  ─────────────────────────────────────────────────────────────────────────────
  WHY NOT `card-detail-prefetch.ts`'s SHAPE
  ─────────────────────────────────────────────────────────────────────────────
  That module is the repo's most disciplined cache and was the obvious model, but
  its entries are PROMISES, and a promise cannot seed `useState`. The bug being
  fixed is a card that renders a placeholder on frame 1 and its real content on a
  later frame — so what is needed is a value readable SYNCHRONOUSLY during the
  first render. Hence two maps with different jobs:

    `values`   — the last resolved answer per post, read synchronously by `peek`.
                 No TTL: it is never trusted as the answer, only used to draw
                 something better than a grey box while the real answer loads.
    `inFlight` — request de-duplication. Two bubbles pointing at the same post,
                 or a row scrolled out and back, share one round trip instead of
                 racing. `fetchPostById` costs two sequential waves (the post,
                 then its author), so this is worth having.
*/

/** Enough for any thread's worth of shared posts; oldest evicted first. */
const MAX_ENTRIES = 60;

/** Last resolved answer per post id. `null` = resolved as unavailable. */
const values = new Map<string, FeedPost | null>();
/** Requests currently on the wire, so concurrent readers share one. */
const inFlight = new Map<string, Promise<FeedPost | null>>();

function remember(postId: string, post: FeedPost | null): void {
  // Re-insert so `values` keeps insertion order as recency order.
  values.delete(postId);
  values.set(postId, post);
  while (values.size > MAX_ENTRIES) {
    const oldest = values.keys().next().value;
    if (!oldest) {
      break;
    }
    values.delete(oldest);
  }
}

/**
 * The last answer for this post, or null when there has never been one.
 *
 * Returns a WRAPPER rather than the post itself because `null` is a meaningful
 * answer here — "this post resolved as unavailable" has to be distinguishable
 * from "nothing cached", and both would otherwise be `null`.
 */
export function peekSharedPost(postId: string): { post: FeedPost | null } | null {
  if (!postId || !values.has(postId)) {
    return null;
  }
  return { post: values.get(postId) ?? null };
}

/**
 * Read the post, sharing an in-flight request with any other caller asking for
 * the same id. ALWAYS hits the network — see the note at the top of this file.
 */
export function loadSharedPost(postId: string): Promise<FeedPost | null> {
  const existing = inFlight.get(postId);
  if (existing) {
    return existing;
  }
  const request = fetchPostById(postId)
    .then((post) => {
      remember(postId, post);
      return post;
    })
    .finally(() => {
      inFlight.delete(postId);
    });
  inFlight.set(postId, request);
  return request;
}

/**
 * Drop everything. Module state outlives a single test, and a warm cache leaking
 * between tests is how a "paints on the first frame" assertion passes for the
 * wrong reason — call this in `beforeEach`.
 */
export function clearSharedPostCache(): void {
  values.clear();
  inFlight.clear();
}
