import type { NewsItem } from '@spotlight/api-client';

import {
  mergeMixedFeed,
  mixedFeedHorizon,
  sourcesToAdvance,
  type MixedFeedSources,
} from '@/features/social/for-you-feed';
import type { FeedItem, FeedPost } from '@/features/social/social-service';

function postRow(id: string, at: string, extra: Partial<FeedItem> = {}, news?: FeedPost['news']): FeedItem {
  const post: FeedPost = {
    id,
    authorId: `author-${id}`,
    author: null,
    body: id,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: at,
    media: [],
    ...(news ? { news } : {}),
  };
  return { key: `post:${id}`, post, repostedBy: null, repostedById: null, repostedAt: null, activityAt: at, ...extra };
}

function article(id: string, at: string, url = `https://news.test/${id}`): NewsItem {
  return {
    id,
    kind: 'news',
    source: 'Polygon',
    title: id,
    url,
    imageUrl: null,
    publishedAt: at,
    game: null,
    setId: null,
    cardIds: [],
    tags: [],
    video: null,
  };
}

const keys = (sources: MixedFeedSources) => mergeMixedFeed(sources).map((row) => row.key);

describe('for-you feed merge', () => {
  it('orders both sources by time across timestamp formats', () => {
    expect(
      keys({
        posts: [postRow('p2', '2026-05-03T00:00:00.123456+00:00'), postRow('p1', '2026-05-01T00:00:00+00:00')],
        postsDone: true,
        news: [article('n1', '2026-05-02T00:00:00Z')],
        newsDone: true,
      }),
    ).toEqual(['post:p2', 'news:n1', 'post:p1']);
  });

  it('holds back rows older than a source that can still page', () => {
    const sources: MixedFeedSources = {
      posts: [postRow('p2', '2026-05-05T00:00:00Z'), postRow('p1', '2026-05-04T00:00:00Z')],
      postsDone: false,
      news: [article('n2', '2026-05-06T00:00:00Z'), article('n1', '2026-05-01T00:00:00Z')],
      newsDone: false,
    };
    // Posts reach back only to 05-04, so the 05-01 story must wait.
    expect(mixedFeedHorizon(sources)).toBe(Date.parse('2026-05-04T00:00:00Z'));
    expect(keys(sources)).toEqual(['news:n2', 'post:p2', 'post:p1']);
    expect(sourcesToAdvance(sources)).toEqual(['posts']);
  });

  it('shows everything once every source is exhausted', () => {
    const sources: MixedFeedSources = {
      posts: [postRow('p1', '2026-05-04T00:00:00Z')],
      postsDone: true,
      news: [article('n1', '2026-05-01T00:00:00Z')],
      newsDone: true,
    };
    expect(keys(sources)).toEqual(['post:p1', 'news:n1']);
    expect(sourcesToAdvance(sources)).toEqual([]);
  });

  it('keeps only the newest row for a reposted article', () => {
    const url = 'https://news.test/shared';
    const repost = postRow(
      'thread',
      '2026-05-09T00:00:00Z',
      { key: 'repost:thread:a', repostedById: 'a' },
      { source: 'Polygon', url, imageUrl: null },
    );
    const secondRepost = { ...repost, key: 'repost:thread:b', repostedById: 'b', activityAt: '2026-05-07T00:00:00Z' };
    expect(
      keys({
        posts: [repost, secondRepost],
        postsDone: true,
        news: [article('shared', '2026-05-08T00:00:00Z', url)],
        newsDone: true,
      }),
    ).toEqual(['repost:thread:a']);
  });

  it('drops duplicate keys a re-read page may return', () => {
    const row = postRow('p1', '2026-05-04T00:00:00Z');
    expect(keys({ posts: [row, row], postsDone: true, news: [], newsDone: true })).toEqual(['post:p1']);
  });
});
