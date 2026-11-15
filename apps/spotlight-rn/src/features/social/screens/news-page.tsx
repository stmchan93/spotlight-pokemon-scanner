import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NewsFeedQuery, NewsItem } from '@spotlight/api-client';
import { StateCard, useSpotlightTheme } from '@spotlight/design-system';

import {
  AnimatedFlatList,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { useNewsPageData } from '@/features/meta-feed/screens/components/meta-page-data';
import { GameFilterChips, type GameFilter } from '@/features/social/components/game-filter-chips';
import { NewsArticleRow } from '@/features/social/components/news-article-row';
import { fetchNewsThreads, type NewsThread } from '@/features/social/news-thread-service';
import { fetchLikedPostIds, fetchRepostedPostIds } from '@/features/social/social-service';
import { useAppServices } from '@/providers/app-providers';

const PAGE_SIZE = 20;

type NewsPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  testID?: string;
};

/** The News tab of the Social screen (Figma 6322:7596). */
export function NewsPage({ page, scrollRef, testID = 'news-page' }: NewsPageProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();

  const [game, setGame] = useState<GameFilter>(null);
  const query = useMemo<NewsFeedQuery>(() => ({ game, limit: PAGE_SIZE }), [game]);
  const { data: firstPage, refresh, status } = useNewsPageData(query);

  const [extraItems, setExtraItems] = useState<NewsItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A page read that lands after the filter changed must not join the new list.
  const pagingToken = useRef(0);

  useEffect(() => {
    pagingToken.current += 1;
    setExtraItems([]);
    setLoadingMore(false);
    setNextCursor(firstPage?.nextCursor ?? null);
  }, [firstPage]);

  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...(firstPage?.items ?? []), ...extraItems].filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }, [extraItems, firstPage]);

  const [threads, setThreads] = useState<Map<string, NewsThread>>(new Map());
  const [likedPostIds, setLikedPostIds] = useState<Set<string>>(new Set());
  const [repostedPostIds, setRepostedPostIds] = useState<Set<string>>(new Set());
  const readNewsIds = useRef(new Set<string>());

  // One batch per page instead of a read per row.
  const readReactions = useCallback(async (newsIds: string[]) => {
    const unread = newsIds.filter((id) => !readNewsIds.current.has(id));
    if (unread.length === 0) {
      return;
    }
    unread.forEach((id) => readNewsIds.current.add(id));
    const found = await fetchNewsThreads(unread);
    if (found.size === 0) {
      return;
    }
    const postIds = Array.from(found.values()).map((thread) => thread.postId);
    const [liked, reposted] = await Promise.all([
      fetchLikedPostIds(postIds).catch(() => new Set<string>()),
      fetchRepostedPostIds(postIds).catch(() => new Set<string>()),
    ]);
    setThreads((current) => new Map([...current, ...found]));
    setLikedPostIds((current) => new Set([...current, ...liked]));
    setRepostedPostIds((current) => new Set([...current, ...reposted]));
  }, []);

  useEffect(() => {
    void readReactions(items.map((item) => item.id));
  }, [items, readReactions]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    readNewsIds.current.clear();
    void (async () => {
      try {
        await refresh();
        await readReactions(items.map((item) => item.id));
      } finally {
        setRefreshing(false);
      }
    })();
  }, [items, readReactions, refresh]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loadingMore) {
      return;
    }
    const token = pagingToken.current;
    setLoadingMore(true);
    void (async () => {
      try {
        const more = await spotlightRepository.fetchNewsFeed({ ...query, cursor: nextCursor });
        if (token !== pagingToken.current) {
          return;
        }
        setExtraItems((current) => [...current, ...(more?.items ?? [])]);
        setNextCursor(more?.nextCursor ?? null);
      } catch {
        // The next scroll to the end tries the same cursor again.
      } finally {
        if (token === pagingToken.current) {
          setLoadingMore(false);
        }
      }
    })();
  }, [loadingMore, nextCursor, query, spotlightRepository]);

  const emptyState =
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
        message="New stories will show up here."
        style={styles.stateCard}
        testID={`${testID}-empty`}
        title="Nothing here yet"
        variant="field"
      />
    );

  return (
    <AnimatedFlatList
      ListEmptyComponent={emptyState}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator color={theme.colors.textSecondary} testID={`${testID}-loading-more`} />
          </View>
        ) : null
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <GameFilterChips includeAll onChange={setGame} testID={`${testID}-chips`} value={game} />
        </View>
      }
      contentContainerStyle={[
        page.contentContainerStyle,
        { paddingBottom: insets.bottom + theme.spacing.xl },
      ]}
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={(item: NewsItem) => item.id}
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
      renderItem={({ item, index }: { item: NewsItem; index: number }) => {
        const thread = threads.get(item.id) ?? null;
        return (
          <NewsArticleRow
            item={item}
            lead={index === 0 && Boolean(item.imageUrl)}
            liked={thread ? likedPostIds.has(thread.postId) : false}
            reposted={thread ? repostedPostIds.has(thread.postId) : false}
            testID={`${testID}-article-${item.id}`}
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
  footer: {
    paddingVertical: 20,
  },
  // Figma 6322:7622: 16 under the tab rail, then 8 + the row's own 12 to the source.
  header: {
    paddingBottom: 8,
    paddingTop: 16,
  },
  stateCard: {
    marginHorizontal: 16,
    marginTop: 16,
  },
});
