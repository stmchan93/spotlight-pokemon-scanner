import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  Animated,
  ActivityIndicator,
  Platform,
  RefreshControl,
  StyleSheet,
  View,
  type FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { AnimatedFlatList } from '@/components/page-tab-pager';
import {
  HOME_HEADER_BAR_HEIGHT,
  HomeHeader,
  SEARCH_PILL_HIDE_DISTANCE,
} from '@/components/home-header';
import { PostCard } from '@/features/social/components/post-card';
import { RepostAttribution } from '@/features/social/components/repost-attribution';
import { getFeedRefreshVersion } from '@/features/social/screens/new-post-screen';
import {
  type FeedItem,
  type FeedPost,
  type FeedPostAuthor,
  fetchGlobalFeedItems,
} from '@/features/social/social-service';
import { useUnreadNotificationCount } from '@/features/social/use-unread-notification-count';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { DrawerEdgeSwipe } from '@/components/drawer-edge-swipe';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

const PAGE_SIZE = 20;

/**
 * How old the displayed feed may be before returning to the tab refetches it.
 *
 * 30s is chosen against the two things it trades off. Engagement counts
 * (`posts.comment_count`, `like_count`) are read at fetch time and never pushed,
 * so this window IS how stale they can get while you are elsewhere in the app.
 * Against that, returning to Home is the most common navigation here, and every
 * refetch is a round trip.
 *
 * Half a minute means walking to a post and back is free, while any real detour
 * — a PDP, the scanner, another tab — comes back to current numbers. Realtime
 * subscriptions would remove the window entirely, at the cost of a live channel
 * per feed view; not worth it for a count.
 */
const FEED_STALE_AFTER_MS = 30_000;


type FeedStatus = 'loading' | 'ready' | 'error';

/**
 * The name for the "<name> reposted" line, or null to let `RepostAttribution`
 * say "You reposted".
 *
 * Matched on HANDLE — unique, and the only identifier `FeedPostAuthor` carries.
 * A handle-less viewer simply gets the reposter's display name, which is still
 * correct, just less personal.
 */
function reposterAttributionName(
  repostedBy: FeedPostAuthor,
  viewerHandle: string | null,
): string | null {
  const reposterHandle = repostedBy.handle?.trim();
  if (viewerHandle && reposterHandle && viewerHandle === reposterHandle) {
    return null;
  }
  return repostedBy.displayName?.trim() || (reposterHandle ? `@${reposterHandle}` : 'Someone');
}

function readFeed(before?: string): Promise<FeedItem[]> {
  return fetchGlobalFeedItems(PAGE_SIZE, before);
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
  const { accessToken, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  // Lets a row you reposted yourself read "You reposted" rather than your name.
  const viewerHandle = currentUser?.handle?.trim() ?? null;

  // Feed rows, not bare posts: a repost is its own row carrying who passed it on.
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadingMoreRef = useRef(false);
  // Last refresh signal THIS screen acted on. Seeded at mount: a signal raised
  // before the feed existed is already reflected in its first load.
  const seenRefreshVersionRef = useRef(getFeedRefreshVersion());
  const unreadCount = useUnreadNotificationCount();

  // The bar FLOATS: the bubbles stay pinned at the top while the pill slides up
  // out of the row, so the list scrolls beneath the whole thing. The offset is
  // handed to `HomeHeader` raw — the bar owns the motion, this screen only
  // measures the scroll.
  /*
    SEEDED AT THE LIST'S RESTING OFFSET, NOT AT 0.

    Reported as "the search pill is gone when I first open the app" — on iOS
    only. This list runs `contentInsetAdjustmentBehavior="automatic"` and so
    RESTS at `-insets.top`, which is what `scrollRestOffset` below tells the bar.
    The bar fades the pill across `[rest, rest + 56]`, i.e. `[-59, -3]` on a
    notched phone.

    Starting the value at 0 therefore starts it PAST the end of that range, so
    the pill rendered at opacity 0 until the first scroll event delivered the
    real offset and snapped it back in. Android was fine because it rests at 0,
    which is why this survived: the simulator most used for this screen agrees
    with the wrong value.

    `insets` is real on this render — `SafeAreaProvider` has no `initialMetrics`
    and renders nothing until it has measured — so the ref captures the right
    number the first time.
  */
  const scrollY = useRef(
    new Animated.Value(Platform.OS === 'ios' ? -insets.top : 0),
  ).current;
  // `pointerEvents` is not animatable, so the departed pill is disarmed from JS
  // or it stays an invisible tap target over the first post.
  const [isSearchPillHidden, setIsSearchPillHidden] = useState(false);

  /*
    "Back to top", the same FAB Collection / Wishlist / Insights already carry.

    THE HOOK'S HANDLER IS NOT PASSED AS `onScroll` HERE. `useScrollToTop(ref,
    onScroll)` wraps whatever it is handed in a plain JS `useCallback`, so
    handing it the `Animated.event` below and using the result as the list's
    `onScroll` is exactly the arrow-function wrap the comment in that event
    warns about — it would silently drop the native driver from `scrollY` and
    the floating bar would start animating over the bridge. Instead the hook is
    given no handler and its `handleScroll` is called from INSIDE the listener
    that already rides on the native event, so the native driver keeps driving
    the bar while visibility is computed in JS off the same event object.

    `topOffset`: `contentInsetAdjustmentBehavior="automatic"` below means UIKit
    insets this list, so on iOS it RESTS at `-insets.top` rather than at 0 —
    the same origin Collection passes as `pageTopOffset`. Android takes the
    explicit-`paddingTop` branch instead (that prop is an iOS no-op) and rests
    at 0, so the offset must be 0 there.
  */
  const scrollRef = useRef<FlatList<FeedItem>>(null);
  const listTopOffset = Platform.OS === 'ios' ? -insets.top : 0;
  const {
    isVisible: showScrollTop,
    handleScroll: trackScrollTopVisibility,
    handleLayout: handleListLayout,
    scrollToTop,
  } = useScrollToTop(scrollRef, undefined, listTopOffset);

  const handleScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
        // The listener rides ON the animated event; wrapping `onScroll` in an
        // arrow function would silently drop the native driver.
        listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          // TRAVEL, not the raw offset: this list rests at `listTopOffset`
          // (negative on iOS), and comparing the raw offset disarmed the pill a
          // whole safe-area inset after the bar had finished fading it out.
          const travelled = event.nativeEvent.contentOffset.y - listTopOffset;
          const hidden = travelled >= SEARCH_PILL_HIDE_DISTANCE;
          setIsSearchPillHidden((previous) => (previous === hidden ? previous : hidden));
          // Plain JS, but still inside the natively-driven handler. See above.
          trackScrollTopVisibility(event);
        },
      }),
    [listTopOffset, scrollY, trackScrollTopVisibility],
  );


  // Delete-your-own-post: confirm → optimistic removal from THIS list → restore
  // + alert if the write fails. The sheet is rendered below the list, not by the
  // row, so the confirmed delete can unmount the row safely.
  /*
    `usePostDeletion` speaks `FeedPost[]`; this list holds `FeedItem[]`. Adapt
    between the two rather than making the hook generic for one caller — the
    same shape Portfolio → Activity uses.

    Rebuilding from the key map preserves the repost attribution across a failed
    delete's restore; a row the map doesn't know can only be a plain post. A
    delete removes EVERY row for that post, original and reposts alike, because
    the post itself is gone.
  */
  const setFeedPosts = useCallback<Dispatch<SetStateAction<FeedPost[]>>>((action) => {
    setItems((current) => {
      // Rows are grouped by post id, in first-appearance order, so the hook sees
      // each post ONCE even when the feed holds both an original and a repost of
      // it — otherwise a delete would hand it duplicates to filter.
      const rowsByPostId = new Map<string, FeedItem[]>();
      for (const item of current) {
        const rows = rowsByPostId.get(item.post.id);
        if (rows) {
          rows.push(item);
        } else {
          rowsByPostId.set(item.post.id, [item]);
        }
      }
      const posts = Array.from(rowsByPostId.values(), (rows) => rows[0].post);
      const next = typeof action === 'function' ? action(posts) : action;

      // Rebuilt in THE HOOK'S order, not re-sorted: a failed delete restores the
      // post at its original index, and re-sorting here would silently move it.
      const rebuilt: FeedItem[] = [];
      for (const post of next) {
        const rows = rowsByPostId.get(post.id);
        if (rows) {
          // Every row for a surviving post survives — original and reposts alike.
          rebuilt.push(...rows);
        } else {
          // A post we no longer hold can only be one the hook just restored,
          // which can only be one the viewer wrote (you cannot delete a repost
          // of someone else's post from here).
          rebuilt.push({
            key: `post:${post.id}`,
            post,
            repostedBy: null,
            repostedAt: null,
            activityAt: post.createdAt,
          });
        }
      }
      return rebuilt;
    });
  }, []);

  const { requestDelete, confirmSheet: deleteConfirmSheet } = usePostDeletion(setFeedPosts, {
    testID: `${testID}-delete-confirm`,
  });

  // Load (or reload) the feed from the top. A per-load token guards against a
  // slower earlier response landing after a faster one (a refresh racing the
  // initial load, or either racing a post-compose reload).
  const loadTokenRef = useRef(0);

  /** When the currently-displayed page was fetched. Drives the staleness check. */
  const lastLoadedAtRef = useRef(0);

  const loadFeed = useCallback(() => {
    const token = ++loadTokenRef.current;
    setStatus('loading');
    setItems([]);
    setHasMore(false);
    loadingMoreRef.current = false;

    void (async () => {
      try {
        const page = await readFeed();
        if (token !== loadTokenRef.current) {
          return;
        }
        setItems(page);
        setHasMore(page.length >= PAGE_SIZE);
        setStatus('ready');
        lastLoadedAtRef.current = Date.now();
      } catch {
        if (token !== loadTokenRef.current) {
          return;
        }
        setStatus('error');
      }
    })();
  }, []);

  /**
   * Re-read the first page WITHOUT blanking what is on screen — no spinner, no
   * empty state, no scroll jump if nothing changed. Used by the focus refetch,
   * where the user is looking at the feed and only the numbers should move.
   *
   * Shares `loadTokenRef` with every other read, so a quiet refetch racing a
   * pull-to-refresh or a load-more resolves to whichever was requested last
   * rather than to whichever server responded first.
   *
   * Failure is deliberately SILENT: the page already on screen stays, and the
   * user is not shown an error for a refresh they never asked for. A genuine
   * cold-load failure still surfaces through `loadFeed`.
   */
  const refetchFeedQuietly = useCallback(() => {
    const token = ++loadTokenRef.current;
    loadingMoreRef.current = false;
    void (async () => {
      try {
        const page = await readFeed();
        if (token !== loadTokenRef.current) {
          return;
        }
        setItems(page);
        setHasMore(page.length >= PAGE_SIZE);
        setStatus('ready');
        lastLoadedAtRef.current = Date.now();
      } catch {
        // Keep what is on screen. See above.
      }
    })();
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  /*
    Refetch on focus, for two different reasons with two different urgencies.

    1. The composer flips a one-shot flag after posting. That reload is
       IMMEDIATE and unconditional — your own new post appearing at the top is
       the whole point, and making it wait on a staleness window would read as
       the post having failed.

    2. Otherwise, refetch only if the feed is older than `FEED_STALE_AFTER_MS`.
       This is what makes engagement counts current: `posts.comment_count` is
       read at fetch time, so a feed loaded before someone else commented shows
       their post at the count it had then — reported from two accounts side by
       side, where one saw "1 comment" on a thread that already had 8.

    The throttle is the point of the second branch, not an optimisation on it.
    Bouncing between tabs is the single most common navigation in this app, and
    an unconditional refetch would put a network round trip on every one of
    them. A window means the counts are current when you actually come back to
    read the feed, and free when you are just passing through.

    QUIET on purpose: this goes through `refetchFeedQuietly`, not `loadFeed`.
    `loadFeed` blanks the list and shows a spinner, which is right for a cold
    open and completely wrong here — it would flash an empty feed every time you
    returned to the tab.
  */
  useFocusEffect(
    useCallback(() => {
      // Compare-and-record rather than read-and-clear: the owner's Activity tab
      // watches the same counter and must see this signal too.
      if (seenRefreshVersionRef.current !== getFeedRefreshVersion()) {
        seenRefreshVersionRef.current = getFeedRefreshVersion();
        loadFeed();
        return;
      }
      if (Date.now() - lastLoadedAtRef.current >= FEED_STALE_AFTER_MS) {
        refetchFeedQuietly();
      }
    }, [loadFeed, refetchFeedQuietly]),
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
        setItems(page);
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
    if (!hasMore || loadingMoreRef.current || status !== 'ready' || items.length === 0) {
      return;
    }
    // The cursor is the last row's ACTIVITY time, not its post's creation time —
    // a reposted row sorts on when it was reposted, so paging on `createdAt`
    // would skip straight past everything between the two.
    const cursor = items[items.length - 1]?.activityAt;
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
        setItems((current) => {
          // The two sources are merged per page, so a row can legitimately be
          // re-returned by the next page's over-fetch. Key-dedupe on append.
          const seen = new Set(current.map((item) => item.key));
          return [...current, ...page.filter((item) => !seen.has(item.key))];
        });
        setHasMore(page.length >= PAGE_SIZE);
      } catch {
        // Keep what's loaded and stop paging rather than blanking the feed.
        setHasMore(false);
      } finally {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    })();
  }, [hasMore, items, status]);

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
      Left-edge drag opens the hamburger drawer.

      This has now been lost twice to rewrites of this screen, so: it is not
      decoration. The drawer is the only way to Insights, Messages, Wishlist's
      siblings and Account, and Home is the landing screen — without this the
      gesture works on You and nowhere else, which reads as broken rather than
      absent.

      WRAPPER, not the overlay strip: as an ancestor it sees every touch through
      the capture phase while the list keeps receiving them normally, and it is
      the only mode that can cancel the post under your finger once the drag is
      unambiguously a drawer swipe. Safe above the list — its PanResponder
      handlers force a real stacking context, so the `subviews[0]` walk that
      drives tab-bar minimize still reaches the FlatList.
    */
    <DrawerEdgeSwipe>
    <SafeAreaView
      // 'top' is consumed HERE, once. The bar is a row of the list below, so if
      // it also added the inset itself the first post sat a whole status bar too
      // far down — which is exactly what it did.
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <AnimatedFlatList
        ref={scrollRef}
        // This screen became the Home TAB, so a tab bar now sits over its
        // bottom edge. `automatic` puts the list on UIKit's own inset
        // behaviour — the same prop the Collection list uses — so the last post
        // clears the bar instead of hiding behind it, rather than us guessing
        // the native bar's height from a token sized for the retired JS one.
        contentInsetAdjustmentBehavior="automatic"
        /*
          Let a tap through to the comment sheet while its keyboard is up.

          Unset, `ScrollView._handleStartShouldSetResponderCapture` claims the
          FIRST touch whenever a `TextInput` is focused and hands it to the
          keyboard dismissal instead — RN's own comment calls it "the first tap
          should be sent to the scroll view and dismiss the keyboard, then the
          second tap goes to the actual interior view". Capture runs root→target,
          so THIS list was stealing taps from a sheet mounted several levels
          below it: send took two taps, and so did ⋯, like, reply and close.

          `"handled"` (not `"always"`) keeps tapping the background dismissing
          the keyboard, which is the behaviour that prop was protecting.
        */
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          /*
            Reserve the floating bar's height, and NOT the status bar on top of
            it — that was a whole status bar of dead white between the bar and
            the first post.

            `contentInsetAdjustmentBehavior="automatic"` above already insets
            this scroll view by the top safe area; adding `insets.top` here
            counted it a second time. What is left to reserve is only the bar
            itself (`HOME_HEADER_BAR_HEIGHT` = 8 + the 40pt control row + 8).

            ANDROID keeps the explicit inset: `contentInsetAdjustmentBehavior`
            is an iOS-only prop (a no-op in the Android ScrollView), so there is
            nothing there to double-count and dropping it would slide the first
            post under the status bar.
          */
          paddingTop:
            Platform.OS === 'ios'
              ? HOME_HEADER_BAR_HEIGHT
              : insets.top + HOME_HEADER_BAR_HEIGHT,
          paddingBottom: insets.bottom + 24,
          // No horizontal padding and no inter-item gap: post cards are
          // full-bleed and carry their own 16pt top inset, which is exactly the
          // gap Figma leaves between a card's closing hairline and the next
          // avatar. State cards re-inset themselves below.
        }}
        data={items}
        // Keyed on the ROW, not the post: the same post can legitimately appear
        // twice — once on its own, once as somebody's repost.
        keyExtractor={(item: FeedItem) => item.key}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        // Measures the viewport the "Back to top" FAB uses as its threshold —
        // it appears once you have travelled roughly one screen height.
        onLayout={handleListLayout}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        // RN clamps a NEGATIVE scrollTo target to 0 unless this is set
        // (RCTScrollViewComponentView.mm), and it clamps against
        // `contentInset` — which is empty here, because
        // `contentInsetAdjustmentBehavior="automatic"` above puts the safe area
        // in `adjustedContentInset` instead. Without it "Back to top" lands
        // `insets.top` short of the top and `listTopOffset` is silently inert.
        scrollToOverflowEnabled
        refreshControl={
          <RefreshControl
            onRefresh={handleRefresh}
            refreshing={refreshing}
            testID={`${testID}-refresh`}
            tintColor={theme.colors.gray400}
          />
        }
        renderItem={({ item }: { item: FeedItem }) => (
          <>
            {/*
              The card below carries the ORIGINAL author's name and avatar, so
              without this line a reposted row reads as though the reposter wrote
              it. Same component the two Activity tabs use.
            */}
            {item.repostedBy ? (
              <RepostAttribution
                name={reposterAttributionName(item.repostedBy, viewerHandle)}
                testID={`${testID}-repost-attribution`}
              />
            ) : null}
            <PostCard
              accessToken={accessToken}
              apiBaseUrl={apiBaseUrl}
              onPressCard={handleOpenCard}
              onRequestDelete={requestDelete}
              post={item.post}
              testID={`${testID}-post`}
            />
          </>
        )}
        testID={`${testID}-list`}
      />
      {/*
        AFTER the list so tree order paints it on top, and so UIKit's
        `subviews[0]` walk still reaches the scroller for minimize-on-scroll.
      */}
      <HomeHeader
        floating
        onOpenMenu={openDrawer}
        onOpenSearch={openSearch}
        // The list rests at `-insets.top` on iOS, so the pill's fade has to
        // measure travel from there. See `listTopOffset`.
        scrollRestOffset={listTopOffset}
        scrollY={scrollY}
        searchInteractive={!isSearchPillHidden}
        testID={`${testID}-header`}
        // Home keeps the bell and the `+` (Figma toolbar 3567:22969). Collection
        // draws the same bar with the profile toolbar's edit/share pair — this
        // is the only prop that differs between the two screens.
        trailing={{
          kind: 'home',
          addAccessibilityLabel: 'New post',
          onOpenAdd: openComposer,
          onOpenNotifications: openNotifications,
          unreadCount,
        }}
      />
      {/*
        Bottom-RIGHT, 16pt in, floating clear of the tab bar (Figma 3725:59137).
        No collision with the bar above: `HomeHeader` is pinned to the top edge
        and this is anchored to the bottom one. Visibility is scroll-travel only,
        so a short or empty feed never shows it.
      */}
      <ScrollToTopFab
        onPress={scrollToTop}
        testID={`${testID}-scroll-to-top`}
        visible={showScrollTop}
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
