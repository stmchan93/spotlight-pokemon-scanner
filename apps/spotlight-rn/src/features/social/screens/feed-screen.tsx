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
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { MapPin } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  PageTabs,
  type PageTab,
  PillButton,
  StateCard,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  AnimatedFlatList,
  CollapsibleTabPager,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { HOME_HEADER_BAR_HEIGHT, HomeHeader } from '@/components/home-header';
import { tabBarBottomFadeHeight } from '@/lib/tab-bar-insets';
import { PostCard } from '@/features/social/components/post-card';
import { RepostAttribution } from '@/features/social/components/repost-attribution';
import { MarketWatchPage } from '@/features/social/screens/market-watch-page';
import { NewsPage } from '@/features/social/screens/news-page';
import { getFeedRefreshVersion } from '@/features/social/screens/new-post-screen';
import {
  type FeedItem,
  type FeedPost,
  type FeedPostAuthor,
  feedItemFromPost,
  fetchEventPosts,
  fetchFollowingFeed,
  fetchGlobalFeedItems,
} from '@/features/social/social-service';
import { useFeedShow } from '@/features/events/hooks/use-active-show';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useUnreadNotificationCount } from '@/features/social/use-unread-notification-count';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { getUserInitials } from '@/features/auth/auth-models';
import { fetchFollowing, followUser } from '@/features/profile/profile-service';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { DrawerEdgeSwipe } from '@/components/drawer-edge-swipe';
import { useTabLanding, useTabPagerInnerPosition } from '@/components/tab-pager/tab-pager-page-context';
import { innerPageForLanding } from '@/lib/tab-pager';
import { useScrollToTop } from '@/components/scroll-to-top-fab';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

const PAGE_SIZE = 20;

type HubTab = 'social' | 'news' | 'market';

const HUB_TAB_ORDER: readonly HubTab[] = ['social', 'news', 'market'];
const HUB_TABS: readonly PageTab<HubTab>[] = [
  { value: 'social', label: 'Social' },
  { value: 'news', label: 'News' },
  { value: 'market', label: 'Market Watch' },
];
/** Figma 6322:7596: the toolbar's bottom edge to the tab labels. */
const TOOLBAR_TO_TABS_GAP = 24;

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

/**
 * Which feed the list shows. `forYou` is the Home feed; the chip row offering
 * the others only appears while there is a show to offer (see `useFeedShow`).
 */
type FeedSource = 'forYou' | 'following' | 'show';

async function readFeed(source: FeedSource, showId: string | null, before?: string): Promise<FeedItem[]> {
  if (source === 'following') {
    return (await fetchFollowingFeed(PAGE_SIZE, before)).map(feedItemFromPost);
  }
  if (source === 'show' && showId) {
    return (await fetchEventPosts(showId, PAGE_SIZE, { before })).map(feedItemFromPost);
  }
  return fetchGlobalFeedItems(PAGE_SIZE, before);
}

/**
 * Social feed (Figma 3505:14426). A pinned top bar — menu, tap-to-search pill,
 * notifications — over a full-bleed list of `PostCard`s, each closed by an
 * edge-to-edge hairline. New post lives in the list itself, as the compose
 * prompt row at the top.
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
/**
 * How many of the viewer's followees to read for the feed's follow controls.
 * A feed page shows a couple of dozen authors; anyone following past this many
 * people simply sees "Follow" on a row they already follow, and pressing it is
 * a no-op upsert rather than a wrong write.
 */
const FOLLOW_SET_LIMIT = 500;

export function FeedScreen({ testID = 'feed' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { openDrawer } = useAppDrawer();
  const { accessToken, applyFollowingDelta, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  // Lets a row you reposted yourself read "You reposted" rather than your name.
  const viewerHandle = currentUser?.handle?.trim() ?? null;

  /*
    WHO THE VIEWER ALREADY FOLLOWS — read ONCE for the whole feed, not per card.
    Every author on screen needs the answer, and the answer is one set; asking
    per card would be a query per row. `null` means "not read yet", which is
    what keeps the control off the screen until it can say which state it is in
    (a button that starts on "Follow" and flips to "Following" a beat later is
    worse than one that arrives late).
  */
  const [followedAuthorIds, setFollowedAuthorIds] = useState<Set<string> | null>(null);

  // A show in its window (or one the viewer saved) adds "For you · Following ·
  // <show>" chips. If the show goes away, so does its selection.
  const feedShow = useFeedShow();
  const [activeTab, setActiveTab] = useState<HubTab>('social');
  // News and Market Watch read on first visit, so opening Social doesn't fetch them.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<HubTab>>(() => new Set<HubTab>(['social']));
  const selectTab = useCallback((next: HubTab) => {
    setActiveTab(next);
    setVisitedTabs((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);
  // Revealed by a drag forward from Events: show the NEAR edge, the first page,
  // so the strip reads as one continuous row of pages.
  useTabLanding('social', (edge) => {
    const page = innerPageForLanding(HUB_TAB_ORDER, edge);
    if (page) {
      selectTab(page);
    }
  });
  // The bottom-tab pager reads this to hand a drag back past the first page to
  // the outer strip (Events); Market's forward drag is the end of the chain.
  useTabPagerInnerPosition({ count: HUB_TAB_ORDER.length, index: HUB_TAB_ORDER.indexOf(activeTab) });
  const [selectedSource, setSelectedSource] = useState<FeedSource>('forYou');
  const source: FeedSource = feedShow ? selectedSource : 'forYou';
  const showId = source === 'show' ? (feedShow?.id ?? null) : null;
  // The reads below are stable callbacks; they read the current source here.
  const readFeedRef = useRef((before?: string) => readFeed(source, showId, before));
  readFeedRef.current = (before?: string) => readFeed(source, showId, before);
  const readKey = showId ? `show:${showId}` : source;

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
  /*
    "Back to top", the same FAB Collection / Wishlist / Insights already carry.

    `topOffset`: `contentInsetAdjustmentBehavior="automatic"` below means UIKit
    insets this list, so on iOS it RESTS at `-insets.top` rather than at 0 —
    the same origin Collection passes as `pageTopOffset`. Android takes the
    explicit-`paddingTop` branch instead (that prop is an iOS no-op) and rests
    at 0, so the offset must be 0 there.
  */
  const scrollRef = useRef<FlatList<FeedItem>>(null);
  const newsScrollRef = useRef<CollapsibleScrollTarget | null>(null);
  const marketScrollRef = useRef<CollapsibleScrollTarget | null>(null);
  const pageRefs = useMemo(
    () => ({ social: scrollRef, news: newsScrollRef, market: marketScrollRef }),
    [],
  );
  const listTopOffset = Platform.OS === 'ios' ? -insets.top : 0;
  // FAB removed 2026-09-04 (user request); the hook still supplies the scroll
  // + layout trackers other wiring consumes.
  const {
    handleScroll: trackScrollTopVisibility,
    handleLayout: handleListLayout,
  } = useScrollToTop(scrollRef, undefined, listTopOffset);

  // Native-driven scroll offset for the header: drives the decorative app
  // mark's fade-out (the glass controls themselves never move). Starts at the
  // list's rest offset so the mark is fully visible before the first scroll.
  const headerScrollY = useRef(new Animated.Value(listTopOffset)).current;
  const handlePageScroll = useCallback(
    (page: HubTab, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (page === 'social') {
        trackScrollTopVisibility(event);
      }
    },
    [trackScrollTopVisibility],
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
            repostedById: null,
            repostedAt: null,
            activityAt: post.createdAt,
          });
        }
      }
      return rebuilt;
    });
  }, []);

  // Blocking someone clears EVERY row they are in, not just the card that was
  // tapped: their own posts AND their reposts (which carry someone else's post,
  // so filtering on `post.authorId` alone leaves them on screen — the reported
  // bug). The next read drops them server-side via RLS; this is what makes the
  // block look instant instead of arriving on the next refresh.
  const handleAuthorBlocked = useCallback((userId: string) => {
    setItems((current) => current.filter((item) => (
      item.post.authorId !== userId && item.repostedById !== userId
    )));
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
        const page = await readFeedRef.current();
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
        const page = await readFeedRef.current();
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

  // `readKey`: switching chips is a fresh load of a different feed.
  useEffect(() => {
    loadFeed();
  }, [loadFeed, readKey]);

  const selectSource = useCallback(
    (next: FeedSource) => {
      setSelectedSource(next);
      if (next === 'show' && feedShow) {
        capturePostHogEvent(AnalyticsEvent.eventFeedViewed, { event_id: feedShow.id, source: 'home_chip' });
      }
    },
    [feedShow],
  );

  // The follow set, once per signed-in viewer. Signed out there is nobody to
  // follow FOR, so it stays null and no card draws the control.
  useEffect(() => {
    const viewerId = currentUser?.id;
    if (!viewerId) {
      setFollowedAuthorIds(null);
      return undefined;
    }
    let cancelled = false;
    void fetchFollowing(viewerId, FOLLOW_SET_LIMIT).then((profiles) => {
      if (!cancelled) {
        setFollowedAuthorIds(new Set(profiles.map((profile) => profile.userID)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  /*
    Follow, optimistically and ONE WAY. The row flips to "Following" on the tap
    and the write follows; a failure puts it back, because a control that
    silently keeps a state the server rejected is how someone ends up thinking
    they follow a person they do not. There is no unfollow here by design — see
    `FollowButton`.
  */
  const handleFollowAuthor = useCallback((authorId: string) => {
    if (!authorId) {
      return;
    }
    setFollowedAuthorIds((current) => {
      const next = new Set(current ?? []);
      next.add(authorId);
      return next;
    });
    // Your own "Following" count moves with the tap, as on a profile page.
    applyFollowingDelta(1);
    void followUser(authorId).then((ok) => {
      if (ok) {
        return;
      }
      applyFollowingDelta(-1);
      setFollowedAuthorIds((current) => {
        if (!current) {
          return current;
        }
        const next = new Set(current);
        next.delete(authorId);
        return next;
      });
    });
  }, [applyFollowingDelta]);

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
    }, [
      loadFeed,
      refetchFeedQuietly,
    ]),
  );

  const handleRefresh = useCallback(() => {
    const token = ++loadTokenRef.current;
    setRefreshing(true);
    loadingMoreRef.current = false;
    void (async () => {
      try {
        const page = await readFeedRef.current();
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
        const page = await readFeedRef.current(cursor);
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

  // From a show's feed the composer opens with "Post to <show>" on.
  const openComposer = useCallback(() => {
    router.push((showId ? { pathname: '/new-post', params: { eventId: showId } } : '/new-post') as never);
  }, [router, showId]);

  // Initials fallback for the compose row's avatar — the same derivation
  // Portfolio uses for its profile block.
  const profileInitials = currentUser ? getUserInitials(currentUser) : 'P';

  /*
    Facebook-style compose prompt, pinned as the list's FIRST row.

    The `+` bubble in the floating bar was invisible to users — nobody read the
    glass symbol as "write a post" — so this row replaces it as the way into the
    composer: your avatar next to a gray placeholder, the same prompt the empty
    Activity tab on Portfolio draws (Figma 3147:10061), pushing the same
    `/new-post` route the `+` pushed. A `ListHeaderComponent`, not chrome: it
    scrolls away with the feed, and it renders above the empty/error/loading
    states too, so composing stays reachable when there is nothing to read.

    The row closes with the SAME full-bleed 4pt `gray100` band every post card
    closes with (Figma 4299:94902), so the composer reads as its own section
    rather than the first post's header. Spacing is 16 / band / 16: the 16 under
    the band is the first-cell band's 8pt bottom margin plus the PostCard's 8.
  */
  const composePrompt = (
    <View
      style={[
        styles.composeSection,
        {
          borderBottomColor: theme.colors.gray100,
          // Only while the list is EMPTY. Once posts exist, the FIRST CELL draws
          // this band (see renderItem): Android lays cell 0 over the header's
          // bottom edge, and anything drawn from the header's side got shaved by
          // the cell's background.
          borderBottomWidth: items.length > 0 ? 0 : 4,
        },
      ]}
      testID={`${testID}-compose-divider`}
    >
      <Pressable
        accessibilityLabel="Create a post"
        accessibilityRole="button"
        onPress={openComposer}
        style={({ pressed }) => [
          styles.composePrompt,
          {
            backgroundColor: theme.colors.gray100,
            borderCurve: 'continuous',
            borderRadius: theme.radii.pill,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
        testID={`${testID}-compose-prompt`}
      >
        <Avatar initials={profileInitials} size={24} uri={currentUser?.avatarURL} />
        <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]}>
          WHAT&rsquo;S ON YOUR MIND?
        </Text>
      </Pressable>
      {feedShow ? (
        <View style={styles.sourceChips} testID={`${testID}-source-chips`}>
          <PillButton
            label="For you"
            onPress={() => selectSource('forYou')}
            selected={source === 'forYou'}
            testID={`${testID}-source-for-you`}
            tone="filled"
          />
          <PillButton
            label="Following"
            onPress={() => selectSource('following')}
            selected={source === 'following'}
            testID={`${testID}-source-following`}
            tone="filled"
          />
          <PillButton
            label={feedShow.shortTitle}
            // An icon, not a 📍 emoji: the emoji font's wide bearings pushed the label off-centre.
            leading={
              <MapPin
                color={source === 'show' ? theme.colors.gray0 : theme.colors.gray900}
                height={SOURCE_CHIP_ICON_SIZE}
                strokeWidth={1.5}
                width={SOURCE_CHIP_ICON_SIZE}
              />
            }
            onPress={() => selectSource('show')}
            selected={source === 'show'}
            testID={`${testID}-source-show`}
            tone="filled"
          />
        </View>
      ) : null}
    </View>
  );

  const openSearch = useCallback(() => {
    // THIS SCREEN IS THE SOCIAL TAB, so its magnifier finds PEOPLE. Card search
    // lives on Home's bar and in the scanner; on a feed of posts the thing you
    // are looking for is a person.
    router.push('/search/people' as never);
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
        message={
          source === 'following'
            ? 'Posts from people you follow will show up here.'
            : source === 'show'
              ? 'Posts from the show floor will appear here.'
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

  const hubHeaderHeight = insets.top + HOME_HEADER_BAR_HEIGHT + TOOLBAR_TO_TABS_GAP;

  const renderHubPage = (tab: HubTab, page: CollapsiblePageProps) => {
    if (tab === 'news' || tab === 'market') {
      if (!visitedTabs.has(tab)) {
        return <View style={styles.safeArea} testID={`${testID}-${tab}-placeholder`} />;
      }
      return tab === 'news' ? (
        <NewsPage page={page} scrollRef={newsScrollRef} testID={`${testID}-news`} />
      ) : (
        <MarketWatchPage page={page} scrollRef={marketScrollRef} testID={`${testID}-market`} />
      );
    }
    return (
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
          contentContainerStyle={[
            page.contentContainerStyle,
            // No horizontal padding and no inter-item gap: post cards are
            // full-bleed and carry their own 8pt top inset, which is exactly the
            // gap Figma leaves between a card's closing 4pt band and the next
            // avatar. State cards re-inset themselves below.
            { paddingBottom: insets.bottom + 24 },
          ]}
          data={items}
          // Keyed on the ROW, not the post: the same post can legitimately appear
          // twice — once on its own, once as somebody's repost.
          keyExtractor={(item: FeedItem) => item.key}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
          ListHeaderComponent={composePrompt}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
          // Measures the viewport the "Back to top" FAB uses as its threshold —
          // it appears once you have travelled roughly one screen height.
          onLayout={handleListLayout}
          onScroll={page.onScroll}
          scrollEventThrottle={page.scrollEventThrottle}
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
          refreshControl={
            <RefreshControl
              onRefresh={handleRefresh}
              progressViewOffset={page.progressViewOffset}
              refreshing={refreshing}
              testID={`${testID}-refresh`}
              tintColor={theme.colors.gray400}
            />
          }
          renderItem={({ item, index }: { item: FeedItem; index: number }) => (
            <>
              {/*
                The composer's closing band, drawn BY THE FIRST CELL rather than by
                the header above it: cell 0 paints over the header's bottom edge on
                Android, so anything the header drew on the seam was shaved the
                moment posts loaded. The 8pt bottom margin plus the card's own 8pt
                top inset makes the 16pt under-composer gap (Figma 4299:94902).
              */}
              {index === 0 ? (
                <View
                  style={{
                    backgroundColor: theme.colors.gray100,
                    height: 4,
                    marginBottom: 8,
                  }}
                  testID={`${testID}-first-cell-rule`}
                />
              ) : null}
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
                isFollowingAuthor={
                  followedAuthorIds ? followedAuthorIds.has(item.post.authorId) : null
                }
                onAuthorBlocked={handleAuthorBlocked}
                onFollowAuthor={handleFollowAuthor}
                onPressCard={handleOpenCard}
                eventBadgeMode={source === 'show' ? 'booth' : 'show'}
                onRequestDelete={requestDelete}
                post={item.post}
                testID={`${testID}-post`}
              />
            </>
          )}
          testID={`${testID}-list`}
        />
    );
  };

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
      <CollapsibleTabPager
        // Pages run `contentInsetAdjustmentBehavior="automatic"`, so UIKit already
        // insets them by the top safe area; the chrome must not reserve it twice.
        contentInsetTop={Platform.OS === 'ios' ? insets.top : 0}
        header={
          <View
            style={{ backgroundColor: theme.colors.gray0, height: hubHeaderHeight }}
            testID={`${testID}-hub-header`}
          />
        }
        onChange={selectTab}
        onPageScroll={handlePageScroll}
        order={HUB_TAB_ORDER}
        pageRefs={pageRefs}
        // Same height as the header, so nothing collapses and the tabs stay put.
        pinnedTopInset={hubHeaderHeight}
        renderPage={renderHubPage}
        scrollY={headerScrollY}
        tabBar={
          <View style={{ backgroundColor: theme.colors.gray0 }}>
            <PageTabs
              align="gutter"
              labelSize="caption"
              onChange={selectTab}
              tabs={HUB_TABS}
              testID={`${testID}-tabs`}
              uppercase
              value={activeTab}
            />
          </View>
        }
        testID={`${testID}-pager`}
        value={activeTab}
      />
      {/*
        Bottom gradient (Figma 4407:283): solid white at the edge -> clear by
        ~94% up a 95pt band, fading the feed out under the floating tab bar.

        95 FLAT, not `insets.bottom + 95`: the mock's frame is drawn on a
        home-indicator device, so its 95 already includes the bottom inset.
        Adding the inset again pushed the fade ~34pt higher than designed and
        it read as a haze over the content ("the gradient needs to be lower").

        The frame's progressive 0->8 backdrop-blur is intentionally skipped:
        expo-blur can't do gradient blur and a full BlurView reads as a hard
        band.
      */}
      <View pointerEvents="none" style={[styles.bottomGradient, { height: tabBarBottomFadeHeight }]}>
        <Svg height="100%" width="100%">
          <Defs>
            <LinearGradient id="homeBottomFade" x1="0" x2="0" y1="1" y2="0">
              {/* Android: 70% at the edge, matched to the Collection's band
                  (4134:49749) so the two tabs dissolve under the opaque bar the
                  same way (owner, 2026-09-13). iOS keeps the feed frame's own
                  100% (4407:283), where the band also runs under a translucent
                  bar and reads lighter. */}
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={Platform.OS === 'android' ? 0.7 : 1} />
              <Stop offset="0.93684" stopColor="#FFFFFF" stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Rect fill="url(#homeBottomFade)" height="100%" width="100%" x="0" y="0" />
        </Svg>
      </View>
      {/*
        AFTER the pager so tree order paints it on top, and so UIKit's
        `subviews[0]` walk still reaches the scroller for minimize-on-scroll.
      */}
      <HomeHeader
        floating
        onOpenMenu={openDrawer}
        onOpenSearch={openSearch}
        scrollRestOffset={listTopOffset}
        scrollY={headerScrollY}
        testID={`${testID}-header`}
        // Home puts search + bell in one trailing glass pill (Figma 4299:94902);
        // the `+` that once sat here moved into the list as the compose prompt
        // row. Collection draws the same bar with the profile toolbar's
        // edit/share pair — this is the only prop that differs between the two
        // screens.
        trailing={{
          kind: 'home',
          onOpenNotifications: openNotifications,
          unreadCount,
        }}
      />
      {deleteConfirmSheet}
    </SafeAreaView>
    </DrawerEdgeSwipe>
  );
}

const SOURCE_CHIP_ICON_SIZE = 16;

const styles = StyleSheet.create({
  bottomGradient: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    // Over the list, under the tab bar chrome.
    zIndex: 4,
  },
  // The filled pill itself (Figma 4299:94902): 8 padding around a 24pt avatar
  // makes the 40pt-tall capsule; fill + radius come from the theme inline.
  composePrompt: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    // The feed's 16 page gutter — the list itself is unpadded (posts are
    // full-bleed), so the pill insets itself, like the state cards below.
    marginHorizontal: 16,
    padding: 8,
  },
  // The band is a BORDER on this row, not a sibling View below it. As a
  // sibling box on the seam between the list header and the first cell, it
  // showed on first paint and vanished when the post below relaid it out
  // (Android only). A border is painted inside a row that has real content, so
  // it has nothing to lose — the same form the DM inbox and follow list use.
  composeSection: {
    alignSelf: 'stretch',
    // 16 below the floating bar's reserved height, and 16 between the pill
    // and the closing band.
    paddingBottom: 16,
    paddingTop: 16,
    width: '100%',
  },
  footerSpinner: {
    paddingVertical: 20,
  },
  sourceChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
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
