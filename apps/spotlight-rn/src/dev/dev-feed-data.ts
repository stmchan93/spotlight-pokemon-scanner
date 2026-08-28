import type { FeedItem, FeedPost } from '@/features/social/social-service';

// Deterministic feed rows for spotlight://dev/feed — one row per content shape
// the feed renders (image post, own post, repost + card chip, deleted author,
// long name). Fewer than one page so pagination stays off.

const VIEWER_ID = '00000000-0000-0000-0000-000000000001';

// 6x8 solid lilac PNG; expo-image renders data URIs without auth.
const MOCK_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAYAAAAICAIAAABVpBlvAAAAEUlEQVR4nGM4ve8BGmIYDEIAVuZzsa2ex1YAAAAASUVORK5CYII=';

function post(
  overrides: Partial<FeedPost> & Pick<FeedPost, 'id' | 'authorId' | 'createdAt'>,
): FeedPost {
  return {
    author: null,
    body: null,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    media: [],
    ...overrides,
  };
}

function row(feedPost: FeedPost, extra?: Partial<FeedItem>): FeedItem {
  return {
    key: `post:${feedPost.id}`,
    post: feedPost,
    repostedBy: null,
    repostedById: null,
    repostedAt: null,
    activityAt: feedPost.createdAt,
    ...extra,
  };
}

export const devFeedItems: FeedItem[] = [
  row(
    post({
      id: 'dev-feed-1',
      authorId: 'dev-author-wabisabi',
      author: { displayName: 'WabiSabi', handle: 'wabisabi', avatarUrl: null, isVerified: true },
      body:
        'Anyone still playing Pokémon Go in 2026? Add me! I am around the Los Angeles area! Looking to trade a Shinnies!',
      likeCount: 20,
      commentCount: 20,
      repostCount: 20,
      createdAt: '2026-07-16T12:00:00.000Z',
      media: [{ id: MOCK_IMAGE, width: 1080, height: 1440, blurhash: null }],
    }),
  ),
  row(
    post({
      id: 'dev-feed-2',
      authorId: VIEWER_ID,
      author: { displayName: 'UI Test User', handle: null, avatarUrl: null, isVerified: false },
      body: 'Pulled this from a single pack at the show. Still shaking.',
      likeCount: 3,
      commentCount: 1,
      createdAt: '2026-07-15T09:30:00.000Z',
    }),
  ),
  row(
    post({
      id: 'dev-feed-3',
      authorId: 'dev-author-kanto',
      author: {
        displayName: 'Kanto Grader',
        handle: 'kantograder',
        avatarUrl: null,
        isVerified: false,
      },
      body: 'Grail secured. PSA 10 population of 12.',
      cardId: 'sm7-1',
      likeCount: 128,
      commentCount: 41,
      repostCount: 9,
      createdAt: '2026-07-10T18:00:00.000Z',
      media: [{ id: MOCK_IMAGE, width: 1080, height: 1440, blurhash: null }],
    }),
    {
      key: 'repost:dev-feed-3:dev-author-wabisabi',
      repostedBy: { displayName: 'WabiSabi', handle: 'wabisabi', avatarUrl: null, isVerified: true },
      repostedById: 'dev-author-wabisabi',
      repostedAt: '2026-07-14T08:00:00.000Z',
      activityAt: '2026-07-14T08:00:00.000Z',
    },
  ),
  row(
    post({
      id: 'dev-feed-4',
      authorId: '',
      body: 'This account no longer exists but the post survives moderation.',
      likeCount: 1,
      createdAt: '2026-07-08T14:00:00.000Z',
    }),
  ),
  row(
    post({
      id: 'dev-feed-5',
      authorId: 'dev-author-longname',
      author: {
        displayName: 'The Extremely Long Display Name Collector Of Greater Los Angeles',
        handle: 'longname',
        avatarUrl: null,
        isVerified: false,
      },
      body: 'Short one.',
      createdAt: '2026-07-01T10:00:00.000Z',
    }),
  ),
];
