import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, ActivityIndicator, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { AnimatedFlatList } from '@/components/page-tab-pager';
import { HOME_HEADER_BAR_HEIGHT, HomeHeader } from '@/components/home-header';
import { PostCard } from '@/features/social/components/post-card';
import { consumeFeedRefreshSignal } from '@/features/social/screens/new-post-screen';
import {
  type FeedPost,
  fetchGlobalFeed,
} from '@/features/social/social-service';
import { useUnreadNotificationCount } from '@/features/social/use-unread-notification-count';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

const PAGE_SIZE = 20;

/**
 * How far the feed scrolls before the top bar's "Search Cards" pill has faded
 * out completely. Same distance Collection uses, so the two surfaces lose their
 * pill at the same point in the gesture — roughly the pill's own height plus the
 * bar's padding, i.e. by the time the first post has reached the bar. The glass
 * bubbles beside it never move.
 */
const SEARCH_FADE_DISTANCE = 56;

type FeedStatus = 'loading' | 'ready' | 'error';

function readFeed(before?: string): Promise<FeedPost[]> {
  return fetchGlobalFeed(PAGE_SIZE, before);
}

/**
 * Social feed (Figma 3505:14426). A pinned top bar — menu, tap-to-search pill,
 * notifications, new post — over a full-bleed list of `PostCard`s, each closed
 * by an edge-to-edge hairline.
 *
 * This is the HOME tab (`(tabs)/index`), so the frame's own Home/Scan/Wishlist/
 * You bar is drawn by the real tab bar around it and this screen still renders
 * its body only.
 *
 * ONE FEED, NEWEST FIRST. It used to carry a Following / Global switch, which is
 * not in the frame; Home is specified as "all the posts, time first", so the
 * screen reads `fetchGlobalFeed` (visible posts, `created_at` descending) and
 * nothing else. `fetchFollowingFeed` is still exported by the service and still
 * tested — it simply has no caller now, which is the cheap half of putting a
 * follow filter back if one is wanted.
 */
export function FeedScreen({ testID = 'feed' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { openDrawer } = useAppDrawer();
  const { accessToken } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();

  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const unreadCount = useUnreadNotificationCount();

  // The list's scroll offset, written by an `Animated.event` on the UI thread so
  // the pill fade tracks the finger instead of running a JS frame behind it.
  // This is the same shape Collection uses; it just owns the value directly
  // rather than reading it off a pager.
  const scrollY = useRef(new Animated.Value(0)).current;
  const searchOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [0, SEARCH_FADE_DISTANCE],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
    [scrollY],
  );
  // `pointerEvents` is not animatable, so the faded-out pill has to be disarmed
  // from JS or it stays an invisible tap target over the first post.
  const [isSearchPillHidden, setIsSearchPillHidden] = useState(false);
  const handleScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
        // The listener rides ON the animated event rather than replacing it —
        // wrapping `onScroll` in an arrow function would silently drop the
        // native driver, because the animated component recognises the event by
        // identity.
        listener: (event: { nativeEvent: { contentOffset: { y: number } } }) => {
          setIsSearchPillHidden(event.nativeEvent.contentOffset.y >= SEARCH_FADE_DISTANCE);
        },
      }),
    [scrollY],
  );

  // Delete-your-own-post: confirm → optimistic removal from THIS list → restore
  // + alert if the write fails. The sheet is rendered below the list, not by the
  // row, so the confirmed delete can unmount the row safely.
  const { requestDelete, confirmSheet: deleteConfirmSheet } = usePostDeletion(setPosts, {
    testID: `${testID}-delete-confirm`,
  });

  // Load (or reload) the feed from the top. A per-load token guards against a
  // slower earlier response landing after a faster one (a refresh racing the
  // initial load, or either racing a post-compose reload).
  const loadTokenRef = useRef(0);

  const loadFeed = useCallback(() => {
    const token = ++loadTokenRef.current;
    setStatus('loading');
    setPosts([]);
    setHasMore(false);
    loadingMoreRef.current = false;

    void (async () => {
      try {
        const page = await readFeed();
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
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  // After composing a post, the composer flips a one-shot flag; reload when the
  // feed regains focus so the new post appears at the top. Returning from
  // anywhere else (e.g. a PDP) leaves the flag clear → no refetch.
  useFocusEffect(
    useCallback(() => {
      if (consumeFeedRefreshSignal()) {
        loadFeed();
      }
    }, [loadFeed]),
  );

  const handleRefresh = useCallback(() => {
    const token = ++loadTokenRef.current;
    setRefreshing(true);
    loadingMoreRef.current = false;
    void (async () => {
      try {
        const page = await readFeed();
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
  }, []);

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
        const page = await readFeed(cursor);
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
  }, [hasMore, posts, status]);

  const handleOpenCard = useCallback(
    (cardId: string) => {
      router.push({ pathname: '/cards/[cardId]', params: { cardId } });
    },
    [router],
  );

  const openComposer = useCallback(() => {
    router.push('/new-post' as never);
  }, [router]);

  const openSearch = useCallback(() => {
    router.push('/catalog/search' as never);
  }, [router]);

  const openNotifications = useCallback(() => {
    router.push('/notifications' as never);
  }, [router]);

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
        message="No posts yet. Check back soon."
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
      // NOT 'top': the bar floats over the list and applies the top inset
      // itself, and the list has to start at y=0 so its content can scroll up
      // BEHIND the glass bubbles rather than stopping below the notch.
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      {/*
        THE LIST COMES FIRST, the bar after it. Two reasons, and both break
        silently if the order is flipped:
          - the bar has no background, so it must PAINT over the list, and with
            no zIndex fight that is simply tree order;
          - UIKit finds the scroll view for minimize-on-scroll by walking
            `subviews[0]` down from the tab screen, so the list has to be the
            first child or the native tab bar stops collapsing.
      */}
      <AnimatedFlatList
        // This screen became the Home TAB, so a tab bar now sits over its
        // bottom edge. `automatic` puts the list on UIKit's own inset
        // behaviour — the same prop the Collection list uses — so the last post
        // clears the bar instead of hiding behind it, rather than us guessing
        // the native bar's height from a token sized for the retired JS one.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          // The bar is absolutely positioned and contributes nothing to layout,
          // so the first post would start underneath it. Reserve exactly its
          // height; the constant lives with the bar so the two cannot drift.
          paddingTop: insets.top + HOME_HEADER_BAR_HEIGHT,
          paddingBottom: insets.bottom + 24,
          // No horizontal padding and no inter-item gap: post cards are
          // full-bleed and carry their own 16pt top inset, which is exactly the
          // gap Figma leaves between a card's closing hairline and the next
          // avatar. State cards re-inset themselves below.
        }}
        data={posts}
        keyExtractor={(item: FeedPost) => item.id}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        onScroll={handleScroll}
        refreshControl={
          <RefreshControl
            onRefresh={handleRefresh}
            // Drop the spinner below the floating bar rather than letting it
            // spin up behind the glass bubbles.
            progressViewOffset={insets.top + HOME_HEADER_BAR_HEIGHT}
            refreshing={refreshing}
            testID={`${testID}-refresh`}
            tintColor={theme.colors.gray400}
          />
        }
        renderItem={({ item }: { item: FeedPost }) => (
          <PostCard
            accessToken={accessToken}
            apiBaseUrl={apiBaseUrl}
            onPressCard={handleOpenCard}
            onRequestDelete={requestDelete}
            post={item}
            testID={`${testID}-post`}
          />
        )}
        scrollEventThrottle={16}
        testID={`${testID}-list`}
      />
      <HomeHeader
        addAccessibilityLabel="New post"
        onOpenAdd={openComposer}
        onOpenMenu={openDrawer}
        onOpenNotifications={openNotifications}
        onOpenSearch={openSearch}
        searchInteractive={!isSearchPillHidden}
        searchOpacity={searchOpacity}
        testID={`${testID}-header`}
        unreadCount={unreadCount}
      />
      {deleteConfirmSheet}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  footerSpinner: {
    paddingVertical: 20,
  },
  safeArea: {
    flex: 1,
  },
  stateCard: {
    marginTop: 16,
    // Re-inset state cards since the list itself has no horizontal padding.
    marginHorizontal: 16,
  },
});
