import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchNewsThreads, type NewsThread } from '@/features/social/news-thread-service';
import { fetchLikedPostIds, fetchRepostedPostIds } from '@/features/social/social-service';

export type NewsReactions = {
  threads: ReadonlyMap<string, NewsThread>;
  likedPostIds: ReadonlySet<string>;
  repostedPostIds: ReadonlySet<string>;
  /** Forget what was read so the next `newsIds` change re-reads every article. */
  reset: () => void;
};

/**
 * Reaction counts + the viewer's like/repost state for the articles on screen:
 * ONE batch per newly-seen set of ids (a page), never a read per row. Ids already
 * read are skipped, so appending a page reads only that page.
 */
export function useNewsReactions(newsIds: readonly string[]): NewsReactions {
  const [threads, setThreads] = useState<Map<string, NewsThread>>(() => new Map());
  const [likedPostIds, setLikedPostIds] = useState<Set<string>>(() => new Set());
  const [repostedPostIds, setRepostedPostIds] = useState<Set<string>>(() => new Set());
  const readIds = useRef(new Set<string>());
  const [resetToken, setResetToken] = useState(0);

  const idsKey = newsIds.join('|');
  useEffect(() => {
    const unread = newsIds.filter((id) => !readIds.current.has(id));
    if (unread.length === 0) {
      return;
    }
    unread.forEach((id) => readIds.current.add(id));
    void (async () => {
      const found = await fetchNewsThreads(unread);
      if (found.size === 0) {
        return;
      }
      const postIds = Array.from(found.values(), (thread) => thread.postId);
      const [liked, reposted] = await Promise.all([
        fetchLikedPostIds(postIds).catch(() => new Set<string>()),
        fetchRepostedPostIds(postIds).catch(() => new Set<string>()),
      ]);
      setThreads((current) => new Map([...current, ...found]));
      setLikedPostIds((current) => new Set([...current, ...liked]));
      setRepostedPostIds((current) => new Set([...current, ...reposted]));
    })();
    // `idsKey` stands in for the array, which is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, resetToken]);

  const reset = useCallback(() => {
    readIds.current.clear();
    setResetToken((token) => token + 1);
  }, []);

  return { threads, likedPostIds, repostedPostIds, reset };
}
