import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { HomeHeader, HomeHeaderPinnedPill } from '@/components/home-header';
import { PostCard } from '@/features/social/components/post-card';
import { consumeFeedRefreshSignal } from '@/features/social/screens/new-post-screen';
import {
  type FeedPost,
  fetchGlobalFeed,
} from '@/features/social/social-service';
import { useUnreadNotificationCount } from '@/features/social/use-unread-notification-count';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { DrawerEdgeSwipe } from '@/components/drawer-edge-swipe';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

const PAGE_SIZE = 20;


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
    /*
      Left-edge drag opens the hamburger drawer — the same gesture Collection has
      always had, which followed Collection to the You tab when the feed took
      over Home. The hamburger BUTTON was here from the start; only the drag was
      missing, so on the app's landing screen the gesture looked deleted.

      WRAPPER, not an overlay strip, for the reason the component documents: as
      an ancestor it sees every touch through the capture phase while the list
      keeps receiving them normally, and it is the only mode that can cancel the
      post underneath once the drag is unambiguously a drawer swipe. It is also
      safe to put above the list here — `(tabs)/_layout.tsx` notes that its
      PanResponder handlers set `ViewEvents` bits, which force a real stacking
      context, so the `subviews[0]` walk that drives tab-bar minimize still
      reaches the FlatList.
    */
    <DrawerEdgeSwipe>
    <SafeAreaView
      // 'top' is consumed HERE, once. The bar is a row of the list below, so if
      // it also added the inset itself the first post sat a whole status bar too
      // far down — which is exactly what it did.
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <FlatList
        // This screen became the Home TAB, so a tab bar now sits over its
        // bottom edge. `automatic` puts the list on UIKit's own inset
        // behaviour — the same prop the Collection list uses — so the last post
        // clears the bar instead of hiding behind it, rather than us guessing
        // the native bar's height from a token sized for the retired JS one.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingBottom: insets.bottom + 24,
          // No horizontal padding and no inter-item gap: post cards are
          // full-bleed and carry their own 16pt top inset, which is exactly the
          // gap Figma leaves between a card's closing hairline and the next
          // avatar — and, under the bar's rule, the 16pt Figma leaves there too.
          // State cards re-inset themselves below.
        }}
        data={posts}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        // THE BAR IS A LIST ROW, not chrome pinned over the list. That is the
        // whole behaviour: it scrolls up and away with the posts under it, and
        // the rule it carries reads as the top of the page rather than as an
        // edge the content slides beneath.
        ListHeaderComponent={(
          <HomeHeader
            addAccessibilityLabel="New post"
            onOpenAdd={openComposer}
            onOpenMenu={openDrawer}
            onOpenNotifications={openNotifications}
            onOpenSearch={openSearch}
            // The pill pins in its own layer below; this row keeps the hole so
            // the bubbles do not shift when it leaves.
            pillPinnedSeparately
            // Already inside the SafeAreaView above; adding it again is the
            // double-count that opened the gap under the search bar.
            topInset={0}
            testID={`${testID}-header`}
            unreadCount={unreadCount}
          />
        )}
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
            onRequestDelete={requestDelete}
            post={item}
            testID={`${testID}-post`}
          />
        )}
        testID={`${testID}-list`}
      />
      {/*
        Pinned OVER the list, so it holds still while the bubbles beside it
        scroll away as an ordinary list row. After the list, because tree order
        is what puts it on top.
      */}
      <HomeHeaderPinnedPill
        onOpenSearch={openSearch}
        testID={`${testID}-header`}
        topInset={0}
      />
      {deleteConfirmSheet}
    </SafeAreaView>
    </DrawerEdgeSwipe>
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
