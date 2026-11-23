import type { NewsItem } from '@spotlight/api-client';

import type { FeedItem } from '@/features/social/social-service';

/**
 * FOR YOU = posts and news articles in ONE timeline, newest first (Figma
 * 6642:5420). The pure half: how two independently paged sources become one
 * list that never shows a row out of order.
 *
 * THE HORIZON. Each source pages on its own cursor, so after a read the two
 * reach back to different times. A row may only be shown once every source
 * that still has more has been read past it — otherwise the next page of the
 * lagging source could hold something NEWER than rows already on screen, and
 * it would have to be spliced in above where the user is reading. So the list
 * stops at the horizon: the newest "oldest loaded row" among the sources that
 * are not exhausted. Rows below it are held back until the source that set the
 * horizon reads its next page (`sourcesToAdvance`).
 */

export type ForYouRow =
  | { kind: 'post'; key: string; at: number; item: FeedItem }
  | { kind: 'news'; key: string; at: number; news: NewsItem };

export type MixedFeedSources = {
  posts: readonly FeedItem[];
  /** No older posts to read. */
  postsDone: boolean;
  news: readonly NewsItem[];
  /** No older news to read — or news is not part of this feed at all. */
  newsDone: boolean;
};

export type MixedFeedSource = 'posts' | 'news';

/** Epoch ms for an ISO time; postgres (`+00:00`, µs) and backend (`Z`) forms sort together. */
function timeOf(iso: string | null | undefined): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function oldest(times: number[]): number | null {
  return times.length > 0 ? Math.min(...times) : null;
}

/** The oldest loaded time per source that can still page; null when it is exhausted. */
function sourceFloors(sources: MixedFeedSources): Record<MixedFeedSource, number | null> {
  return {
    posts: sources.postsDone ? null : oldest(sources.posts.map((item) => timeOf(item.activityAt))) ?? Infinity,
    news: sources.newsDone ? null : oldest(sources.news.map((item) => timeOf(item.publishedAt))) ?? Infinity,
  };
}

/** Rows at or after this time are safe to show; -Infinity once every source is exhausted. */
export function mixedFeedHorizon(sources: MixedFeedSources): number {
  const floors = Object.values(sourceFloors(sources)).filter((floor): floor is number => floor != null);
  return floors.length > 0 ? Math.max(...floors) : -Infinity;
}

/**
 * The source(s) holding the horizon up — the ones to page next to show more.
 * Empty when both are exhausted.
 */
export function sourcesToAdvance(sources: MixedFeedSources): MixedFeedSource[] {
  const floors = sourceFloors(sources);
  const horizon = mixedFeedHorizon(sources);
  return (Object.keys(floors) as MixedFeedSource[]).filter((source) => floors[source] === horizon);
}

/** The article URL a row carries, for de-duplicating reposted news. */
function newsUrlOf(row: ForYouRow): string | null {
  if (row.kind === 'news') {
    return row.news.url || null;
  }
  return row.item.post.news?.url || null;
}

/**
 * The visible timeline: both sources merged newest-first, cut at the horizon.
 *
 * A REPOSTED ARTICLE APPEARS ONCE. Someone reposting a story puts its hidden
 * thread post in the posts source as a repost row; the story itself is also in
 * the news source. Keyed on the article URL, the NEWER of the two (the first in
 * display order) is kept. Because rows only ever join BELOW the horizon, the
 * kept row is always already on screen when its duplicate arrives — nothing
 * visible is ever swapped out by a later page.
 */
export function mergeMixedFeed(sources: MixedFeedSources): ForYouRow[] {
  const horizon = mixedFeedHorizon(sources);
  const rows: ForYouRow[] = [
    ...sources.posts.map((item): ForYouRow => ({
      kind: 'post',
      key: item.key,
      at: timeOf(item.activityAt),
      item,
    })),
    ...sources.news.map((news): ForYouRow => ({
      kind: 'news',
      key: `news:${news.id}`,
      at: timeOf(news.publishedAt),
      news,
    })),
  ]
    .filter((row) => row.at >= horizon)
    // Stable on ties: posts were listed first, so a post and a story published
    // in the same millisecond keep a fixed order across renders.
    .sort((a, b) => b.at - a.at);

  const seenKeys = new Set<string>();
  const seenArticles = new Set<string>();
  return rows.filter((row) => {
    if (seenKeys.has(row.key)) {
      return false;
    }
    seenKeys.add(row.key);
    const url = newsUrlOf(row);
    if (url) {
      if (seenArticles.has(url)) {
        return false;
      }
      seenArticles.add(url);
    }
    return true;
  });
}
