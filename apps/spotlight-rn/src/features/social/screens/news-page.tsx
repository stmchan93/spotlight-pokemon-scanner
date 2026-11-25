import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, View, type FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NewsItem } from '@spotlight/api-client';
import { StateCard, spacing, useSpotlightTheme } from '@spotlight/design-system';

import {
  AnimatedFlatList,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { NewsArticleRow } from '@/features/social/components/news-article-row';
import { useNewsReactions } from '@/features/social/use-news-reactions';
import { useAppServices } from '@/providers/app-providers';

/** Articles per read; the API caps a page at 50. Same page size FOR YOU reads. */
const NEWS_PAGE_SIZE = 20;

type Status = 'loading' | 'ready' | 'error';

type NewsPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  testID?: string;
};

/**
 * NEWS on Social (Figma 6769:6887): the news lane of FOR YOU on its own —
 * the backend news feed, newest first, paged on its cursor, with the same rows
 * and reactions FOR YOU draws.
 */
export function NewsPage({ page, scrollRef, testID = 'news' }: NewsPageProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();

  const [items, setItems] = useState<NewsItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Guards against a slower earlier read landing after a newer one.
  const loadTokenRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const newsIds = useMemo(() => items.map((item) => item.id), [items]);
  const reactions = useNewsReactions(newsIds);
  const resetReactions = reactions.reset;

  const readFirstPage = useCallback(
    async (mode: 'load' | 'refresh') => {
      const token = ++loadTokenRef.current;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      if (mode === 'refresh') {
        setRefreshing(true);
        resetReactions();
      }
      try {
        const feed = await spotlightRepository.fetchNewsFeed({ limit: NEWS_PAGE_SIZE, cursor: null });
        if (token !== loadTokenRef.current) {
          return;
        }
        setItems(feed?.items ?? []);
        setCursor(feed?.nextCursor ?? null);
        setStatus('ready');
      } catch {
        if (token === loadTokenRef.current) {
          setStatus('error');
        }
      } finally {
        if (token === loadTokenRef.current) {
          setRefreshing(false);
        }
      }
    },
    [resetReactions, spotlightRepository],
  );

  useEffect(() => {
    void readFirstPage('load');
  }, [readFirstPage]);

  const handleRefresh = useCallback(() => {
    void readFirstPage('refresh');
  }, [readFirstPage]);

  const handleLoadMore = useCallback(() => {
    if (loadingMoreRef.current || status !== 'ready' || !cursor) {
      return;
    }
    const token = loadTokenRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const feed = await spotlightRepository.fetchNewsFeed({ limit: NEWS_PAGE_SIZE, cursor });
        if (token !== loadTokenRef.current) {
          return;
        }
        const pageItems = feed?.items ?? [];
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...pageItems.filter((item) => !seen.has(item.id))];
        });
        setCursor(pageItems.length > 0 ? (feed?.nextCursor ?? null) : null);
      } catch {
        // Keep what's loaded and stop paging until the next full read.
        if (token === loadTokenRef.current) {
          setCursor(null);
        }
      } finally {
        if (token === loadTokenRef.current) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    })();
  }, [cursor, spotlightRepository, status]);

  const empty =
    status === 'loading' ? (
      <StateCard
        centered
        loading
        message="Fetching the latest stories."
        style={styles.stateCard}
        testID={`${testID}-loading`}
        title="Loading news"
        variant="field"
      />
    ) : status === 'error' ? (
      <StateCard
        message="Please try again in a moment."
        style={styles.stateCard}
        testID={`${testID}-error`}
        title="Could not load the news"
        variant="field"
      />
    ) : (
      <StateCard
        message="No stories yet. Check back soon."
        style={styles.stateCard}
        testID={`${testID}-empty`}
        title="Nothing here yet"
        variant="field"
      />
    );

  return (
    <AnimatedFlatList
      ListEmptyComponent={empty}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footerSpinner}>
            <ActivityIndicator color={theme.colors.textSecondary} testID={`${testID}-loading-more`} />
          </View>
        ) : null
      }
      contentContainerStyle={[
        page.contentContainerStyle,
        { paddingBottom: insets.bottom + theme.spacing.xl },
      ]}
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={(item: NewsItem) => item.id}
      keyboardShouldPersistTaps="handled"
      onEndReached={handleLoadMore}
      onEndReachedThreshold={0.5}
      onScroll={page.onScroll}
      ref={scrollRef as unknown as RefObject<FlatList<NewsItem>>}
      refreshControl={
        <RefreshControl
          onRefresh={handleRefresh}
          progressViewOffset={page.progressViewOffset}
          refreshing={refreshing}
          testID={`${testID}-refresh`}
          tintColor={theme.colors.gray400}
        />
      }
      renderItem={({ item }: { item: NewsItem }) => {
        const thread = reactions.threads.get(item.id) ?? null;
        return (
          <NewsArticleRow
            item={item}
            lead={Boolean(item.imageUrl)}
            liked={thread ? reactions.likedPostIds.has(thread.postId) : false}
            reposted={thread ? reactions.repostedPostIds.has(thread.postId) : false}
            testID={`${testID}-news-${item.id}`}
            thread={thread}
          />
        );
      }}
      scrollEventThrottle={page.scrollEventThrottle}
      scrollToOverflowEnabled={page.scrollToOverflowEnabled}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  footerSpinner: {
    paddingVertical: spacing.md,
  },
  stateCard: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
  },
});
