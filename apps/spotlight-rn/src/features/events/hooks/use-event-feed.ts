import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchEventPosts, type FeedPost } from '@/features/social/social-service';

export const EVENT_FEED_PAGE_SIZE = 20;

export type EventFeedStatus = 'loading' | 'ready' | 'error';

export type EventFeed = {
  posts: FeedPost[];
  setPosts: React.Dispatch<React.SetStateAction<FeedPost[]>>;
  status: EventFeedStatus;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Blanks and reloads the first page. */
  reload: () => void;
  loadMore: () => void;
};

/**
 * One show's feed (every post tagged `event_id`), newest first, keyset-paged on
 * `created_at` — the main feed's paging contract. Latest-request-wins.
 */
export function useEventFeed(eventId: string): EventFeed {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [status, setStatus] = useState<EventFeedStatus>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const tokenRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const reload = useCallback(() => {
    const token = ++tokenRef.current;
    loadingMoreRef.current = false;
    setStatus('loading');
    setPosts([]);
    setHasMore(false);
    void fetchEventPosts(eventId, EVENT_FEED_PAGE_SIZE).then(
      (page) => {
        if (token !== tokenRef.current) {
          return;
        }
        setPosts(page);
        setHasMore(page.length >= EVENT_FEED_PAGE_SIZE);
        setStatus('ready');
      },
      () => {
        if (token === tokenRef.current) {
          setStatus('error');
        }
      },
    );
  }, [eventId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadMore = useCallback(() => {
    const cursor = posts[posts.length - 1]?.createdAt;
    if (!hasMore || loadingMoreRef.current || status !== 'ready' || !cursor) {
      return;
    }
    const token = tokenRef.current;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    void fetchEventPosts(eventId, EVENT_FEED_PAGE_SIZE, { before: cursor })
      .then(
        (page) => {
          if (token !== tokenRef.current) {
            return;
          }
          setPosts((current) => {
            const seen = new Set(current.map((post) => post.id));
            return [...current, ...page.filter((post) => !seen.has(post.id))];
          });
          setHasMore(page.length >= EVENT_FEED_PAGE_SIZE);
        },
        () => setHasMore(false),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      });
  }, [eventId, hasMore, posts, status]);

  return { posts, setPosts, status, hasMore, isLoadingMore, reload, loadMore };
}
