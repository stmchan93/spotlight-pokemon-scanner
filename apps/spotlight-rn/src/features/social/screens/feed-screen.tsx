import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { EditPencil } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  IconButton,
  ScreenHeader,
  SegmentedControl,
  type SegmentedControlItem,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { PostCard } from '@/features/social/components/post-card';
import { consumeFeedRefreshSignal } from '@/features/social/screens/new-post-screen';
import {
  type FeedPost,
  fetchFollowingFeed,
  fetchGlobalFeed,
} from '@/features/social/social-service';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const PAGE_SIZE = 20;

type FeedSegment = 'following' | 'global';
const SEGMENTS: readonly SegmentedControlItem<FeedSegment>[] = [
  { value: 'following', label: 'Following' },
  { value: 'global', label: 'Global' },
];

type FeedStatus = 'loading' | 'ready' | 'error';

function readFeed(segment: FeedSegment, before?: string): Promise<FeedPost[]> {
  return segment === 'following'
    ? fetchFollowingFeed(PAGE_SIZE, before)
    : fetchGlobalFeed(PAGE_SIZE, before);
}

/**
 * Social feed (Phase 3a — read-only). A Following / Global segment over the two
 * feed reads, each a FlatList of read-only PostCards with infinite scroll and
 * pull-to-refresh. No composing or engagement yet.
 */
export function FeedScreen({ testID = 'feed' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const accessToken = useAuth().accessToken;
  const apiBaseUrl = resolveRepositoryBaseUrl();

  const [segment, setSegment] = useState<FeedSegment>('following');
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadingMoreRef = useRef(false);

  // Load (or reload) the active segment from the top. A per-load token guards
  // against a slower earlier segment's response landing after a faster switch.
  const loadTokenRef = useRef(0);

  const loadSegment = useCallback(
    (nextSegment: FeedSegment) => {
      const token = ++loadTokenRef.current;
      setStatus('loading');
      setPosts([]);
      setHasMore(false);
      loadingMoreRef.current = false;

      void (async () => {
        try {
          const page = await readFeed(nextSegment);
          if (token !== loadTokenRef.current) {
            return;
          }
          setPosts(page);
          setHasMore(page.length >= PAGE_SIZE);
          setStatus('ready');
        } catch {
          if (token !== loadTokenRef.current) {
            return;
          }
          setStatus('error');
        }
      })();
    },
    [],
  );

  useEffect(() => {
    loadSegment(segment);
  }, [loadSegment, segment]);

  // After composing a post, the composer flips a one-shot flag; reload the active
  // segment when the feed regains focus so the new post appears at the top.
  // Returning from anywhere else (e.g. a PDP) leaves the flag clear → no refetch.
  useFocusEffect(
    useCallback(() => {
      if (consumeFeedRefreshSignal()) {
        loadSegment(segment);
      }
    }, [loadSegment, segment]),
  );

  const handleRefresh = useCallback(() => {
    const token = ++loadTokenRef.current;
    setRefreshing(true);
    loadingMoreRef.current = false;
    void (async () => {
      try {
        const page = await readFeed(segment);
        if (token !== loadTokenRef.current) {
          return;
        }
        setPosts(page);
        setHasMore(page.length >= PAGE_SIZE);
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
    })();
  }, [segment]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || loadingMoreRef.current || status !== 'ready' || posts.length === 0) {
      return;
    }
    const cursor = posts[posts.length - 1]?.createdAt;
    if (!cursor) {
      return;
    }
    const token = loadTokenRef.current;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);

    void (async () => {
      try {
        const page = await readFeed(segment, cursor);
        if (token !== loadTokenRef.current) {
          return;
        }
        setPosts((current) => [...current, ...page]);
        setHasMore(page.length >= PAGE_SIZE);
      } catch {
        // Keep what's loaded and stop paging rather than blanking the feed.
        setHasMore(false);
      } finally {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    })();
  }, [hasMore, posts, segment, status]);

  const handleOpenCard = useCallback(
    (cardId: string) => {
      router.push({ pathname: '/cards/[cardId]', params: { cardId } });
    },
    [router],
  );

  const listHeader = (
    <View style={styles.chrome}>
      <ScreenHeader
        leftAccessory={<ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />}
        rightAccessory={
          <IconButton
            accessibilityLabel="New post"
            onPress={() => router.push('/new-post' as never)}
            testID={`${testID}-compose`}
            variant="subtle"
          >
            <EditPencil color={theme.colors.textPrimary} height={20} width={20} />
          </IconButton>
        }
        title="Feed"
      />
      <SegmentedControl
        items={SEGMENTS}
        onChange={setSegment}
        testID={`${testID}-segment`}
        value={segment}
      />
    </View>
  );

  const listEmpty =
    status === 'error' ? (
      <StateCard
        message="Please try again in a moment."
        style={styles.stateCard}
        testID={`${testID}-error`}
        title="Could not load the feed"
        variant="field"
      />
    ) : status === 'loading' ? (
      <StateCard
        centered
        loading
        message="Fetching the latest posts."
        style={styles.stateCard}
        testID={`${testID}-loading`}
        title="Loading feed"
        variant="field"
      />
    ) : (
      <StateCard
        message={
          segment === 'following'
            ? 'Follow collectors to see their posts here.'
            : 'No posts yet. Check back soon.'
        }
        style={styles.stateCard}
        testID={`${testID}-empty`}
        title="Nothing here yet"
        variant="field"
      />
    );

  const listFooter = isLoadingMore ? (
    <View style={styles.footerSpinner}>
      <ActivityIndicator color={theme.colors.textSecondary} testID={`${testID}-loading-more`} />
    </View>
  ) : null;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <FlatList
        contentContainerStyle={{
          gap: 12,
          paddingBottom: insets.bottom + 24,
          // No horizontal padding: post cards are full-bleed (edge-to-edge image,
          // Figma 2903-7128). The header + state cards carry their own 16px inset.
        }}
        data={posts}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        ListHeaderComponent={listHeader}
        ListHeaderComponentStyle={styles.headerSpacing}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            onRefresh={handleRefresh}
            refreshing={refreshing}
            testID={`${testID}-refresh`}
            tintColor={theme.colors.gray400}
          />
        }
        renderItem={({ item }) => (
          <PostCard
            accessToken={accessToken}
            apiBaseUrl={apiBaseUrl}
            onPressCard={handleOpenCard}
            post={item}
            testID={`${testID}-post`}
          />
        )}
        testID={`${testID}-list`}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  chrome: {
    gap: 16,
    // The list is edge-to-edge for full-bleed post cards; re-inset the header.
    paddingHorizontal: 16,
  },
  footerSpinner: {
    paddingVertical: 20,
  },
  headerSpacing: {
    marginBottom: 12,
  },
  safeArea: {
    flex: 1,
  },
  stateCard: {
    marginTop: 12,
    // Re-inset state cards since the list itself has no horizontal padding.
    marginHorizontal: 16,
  },
});
