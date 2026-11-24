import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
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

import type { NewsItem } from '@spotlight/api-client';

import {
  PageTabs,
  type PageTab,
  PillButton,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  AnimatedFlatList,
  CollapsibleTabPager,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';

import { HOME_HEADER_BAR_HEIGHT, HomeHeader, type HomeHeaderTrailing } from '@/components/home-header';
import { NewsArticleRow } from '@/features/social/components/news-article-row';
import { PostCard } from '@/features/social/components/post-card';
import { RepostAttribution } from '@/features/social/components/repost-attribution';
import {
  type ForYouRow,
  type MixedFeedSource,
  type MixedFeedSources,
  mergeMixedFeed,
  sourcesToAdvance,
} from '@/features/social/for-you-feed';
import { getFeedRefreshVersion } from '@/features/social/screens/new-post-screen';
import { YourPostsPage } from '@/features/social/screens/your-posts-page';
import { EventsPage } from '@/features/events/screens/events-screen';
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
import { useNewsReactions } from '@/features/social/use-news-reactions';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { fetchFollowing, followUser, unfollowUser } from '@/features/profile/profile-service';
import { resolveRepositoryBaseUrl, useAppServices } from '@/providers/app-providers';
import { useTabLanding, useTabPagerInnerPosition } from '@/components/tab-pager/tab-pager-page-context';
import { innerPageForLanding } from '@/lib/tab-pager';
import { useScrollToTop } from '@/components/scroll-to-top-fab';
import { useAuth } from '@/providers/auth-provider';
import { useGuestGate } from '@/features/auth/use-guest-gate';

const PAGE_SIZE = 20;
/** Articles per news read; the API caps a page at 50. */
const NEWS_PAGE_SIZE = 20;
/**
 * How many source reads one scroll-to-end may chain while the merged list has
 * not grown (see `handleLoadMore`). Bounds a run of news pages that all sit
 * below the posts' horizon, or vice versa.
 */
const MAX_ADVANCE_ROUNDS = 4;

/**
 * Social's tabs (Figma 6642:11165). Market Watch / Top Trends moved to the Home
 * profile's MARKET ANALYTICS tab; news joined the posts in FOR YOU.
 */
export type SocialTab = 'forYou' | 'yourPosts' | 'events';

export const SOCIAL_TAB_ORDER: readonly SocialTab[] = ['forYou', 'yourPosts', 'events'];
const SOCIAL_TABS: readonly PageTab<SocialTab>[] = [
  { value: 'forYou', label: 'For you' },
  { value: 'yourPosts', label: 'Your posts' },
  { value: 'events', label: 'Events' },
];
/** Guests get EVENTS only: FOR YOU / YOUR POSTS read RLS-scoped data a guest has none of. */
export const GUEST_SOCIAL_TAB_ORDER: readonly SocialTab[] = ['events'];
const GUEST_SOCIAL_TABS = SOCIAL_TABS.filter((tab) => GUEST_SOCIAL_TAB_ORDER.includes(tab.value));

/** Parses the `/social?tab=` deep-link param; unknown values are ignored. */
export function parseSocialTab(value: unknown): SocialTab | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return SOCIAL_TAB_ORDER.find((tab) => tab === raw);
}
/** Figma 6642:11183 → 6642:11165: the toolbar's bottom edge to the tab labels. */
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

/** Both sources' loaded rows plus where each one's next page starts. */
type MixedFeedState = MixedFeedSources & {
  posts: FeedItem[];
  news: NewsItem[];
  newsCursor: string | null;
};

const EMPTY_FEED: MixedFeedState = {
  posts: [],
  postsDone: true,
  news: [],
  newsDone: true,
  newsCursor: null,
};

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
 * Social (Figma 6642:5420): a floating bar (lockup, messages, bell) over two
 * tabs.
 *
 * FOR YOU — posts and news articles in ONE timeline by publish time, newest
 * first. Posts (with reposts) come from `fetchGlobalFeedItems`, news from the
 * backend's news feed; each pages on its own cursor and `for-you-feed.ts`
 * merges them without ever splicing a row above one already shown. During a
 * show, chips swap FOR YOU's posts for the Following or show feed (posts only).
 *
 * YOUR POSTS — the viewer's posts and reposts (`YourPostsPage`).
 */
/**
 * How many of the viewer's followees to read for the feed's follow controls.
 * A feed page shows a couple of dozen authors; anyone following past this many
 * people simply sees "Follow" on a row they already follow, and pressing it is
 * a no-op upsert rather than a wrong write.
 */
const FOLLOW_SET_LIMIT = 500;

export function FeedScreen({
  initialTab = 'forYou',
  requestedTab,
  testID = 'feed',
}: {
  /** The tab to open on; the dev route `feed-your-posts` opens YOUR POSTS. */
  initialTab?: SocialTab;
  /** Deep-link page (`/social?tab=`); a change while mounted switches to it. */
  requestedTab?: SocialTab;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
  const { spotlightRepository } = useAppServices();
  const { activeTab, selectTab, visitedTabs } = useSocialHubTabs(
    SOCIAL_TAB_ORDER,
    requestedTab ?? initialTab,
    requestedTab,
  );
  const [selectedSource, setSelectedSource] = useState<FeedSource>('forYou');
  const source: FeedSource = feedShow ? selectedSource : 'forYou';
  const showId = source === 'show' ? (feedShow?.id ?? null) : null;
  // News rides along only on FOR YOU proper; the Following / show chips are
  // people's posts.
  const includeNews = source === 'forYou';
  // The reads below are stable callbacks; they read the current source here.
  const readPostsRef = useRef((before?: string) => readFeed(source, showId, before));
  readPostsRef.current = (before?: string) => readFeed(source, showId, before);
  const readNewsRef = useRef((cursor: string | null) =>
    spotlightRepository.fetchNewsFeed({ limit: NEWS_PAGE_SIZE, cursor }),
  );
  readNewsRef.current = (cursor: string | null) =>
    spotlightRepository.fetchNewsFeed({ limit: NEWS_PAGE_SIZE, cursor });
  const includeNewsRef = useRef(includeNews);
  includeNewsRef.current = includeNews;
  const readKey = showId ? `show:${showId}` : source;

  /*
    FIRST PAGE OF BOTH SOURCES, side by side. One source failing still shows
    the other (an outage of the news backend must not blank people's posts, and
    vice versa); only when every source fails is it an error. A source that
    fails or comes back short is marked done, so paging never retries it until
    the next full read.
  */
  const readFirstPage = useCallback(async (): Promise<MixedFeedState> => {
    const withNews = includeNewsRef.current;
    const [postsResult, newsResult] = await Promise.allSettled([
      readPostsRef.current(),
      withNews ? readNewsRef.current(null) : Promise.resolve(null),
    ]);
    if (postsResult.status === 'rejected' && (!withNews || newsResult.status === 'rejected')) {
      throw postsResult.reason;
    }
    const posts = postsResult.status === 'fulfilled' ? postsResult.value : [];
    const newsPage = newsResult.status === 'fulfilled' ? newsResult.value : null;
    const news = withNews ? (newsPage?.items ?? []) : [];
    return {
      posts,
      postsDone: postsResult.status === 'rejected' || posts.length < PAGE_SIZE,
      news,
      newsCursor: newsPage?.nextCursor ?? null,
      newsDone: news.length === 0 || !newsPage?.nextCursor,
    };
  }, []);

  // Feed rows, not bare posts: a repost is its own row carrying who passed it on.
  const [feed, setFeed] = useState<MixedFeedState>(EMPTY_FEED);
  // Mirrors `feed` for the paging loop, which must read past its own awaits.
  const feedRef = useRef(feed);
  feedRef.current = feed;
  /** The post rows only; deletion and blocking act on these. */
  const setItems = useCallback((action: SetStateAction<FeedItem[]>) => {
    setFeed((current) => ({
      ...current,
      posts: typeof action === 'function' ? action(current.posts) : action,
    }));
  }, []);
  const rows = useMemo(() => mergeMixedFeed(feed), [feed]);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  // Reaction counts for the articles on screen, one batch per new page.
  const visibleNewsIds = useMemo(
    () => rows.flatMap((row) => (row.kind === 'news' ? [row.news.id] : [])),
    [rows],
  );
  const newsReactions = useNewsReactions(visibleNewsIds);
  const resetNewsReactions = newsReactions.reset;
  const isNewsLiked = (newsId: string) => {
    const thread = newsReactions.threads.get(newsId);
    return thread ? newsReactions.likedPostIds.has(thread.postId) : false;
  };
  const isNewsReposted = (newsId: string) => {
    const thread = newsReactions.threads.get(newsId);
    return thread ? newsReactions.repostedPostIds.has(thread.postId) : false;
  };
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
  const scrollRef = useRef<FlatList<ForYouRow>>(null);
  const yourPostsScrollRef = useRef<CollapsibleScrollTarget | null>(null);
  const eventsScrollRef = useRef<CollapsibleScrollTarget | null>(null);
  const pageRefs = useMemo(
    () => ({ forYou: scrollRef, yourPosts: yourPostsScrollRef, events: eventsScrollRef }),
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
    (page: SocialTab, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (page === 'forYou') {
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
  }, [setItems]);

  // Blocking someone clears EVERY row they are in, not just the card that was
  // tapped: their own posts AND their reposts (which carry someone else's post,
  // so filtering on `post.authorId` alone leaves them on screen — the reported
  // bug). The next read drops them server-side via RLS; this is what makes the
  // block look instant instead of arriving on the next refresh.
  const handleAuthorBlocked = useCallback((userId: string) => {
    setItems((current) => current.filter((item) => (
      item.post.authorId !== userId && item.repostedById !== userId
    )));
  }, [setItems]);

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
    setFeed(EMPTY_FEED);
    loadingMoreRef.current = false;
    setIsLoadingMore(false);

    void (async () => {
      try {
        const page = await readFirstPage();
        if (token !== loadTokenRef.current) {
          return;
        }
        setFeed(page);
        setStatus('ready');
        lastLoadedAtRef.current = Date.now();
      } catch {
        if (token !== loadTokenRef.current) {
          return;
        }
        setStatus('error');
      }
    })();
  }, [readFirstPage]);

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
    setIsLoadingMore(false);
    void (async () => {
      try {
        const page = await readFirstPage();
        if (token !== loadTokenRef.current) {
          return;
        }
        setFeed(page);
        setStatus('ready');
        lastLoadedAtRef.current = Date.now();
      } catch {
        // Keep what is on screen. See above.
      }
    })();
  }, [readFirstPage]);

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
    Unfollow from the feed (owner, 2026-11-22): FOLLOWING on a post is the way
    out. Confirmed first — a stray tap on a status-looking box should not
    silently drop someone — then optimistic, put back if the write fails.
  */
  const handleUnfollowAuthor = useCallback((authorId: string, displayName: string) => {
    if (!authorId) {
      return;
    }
    const unfollow = () => {
      setFollowedAuthorIds((current) => {
        if (!current) {
          return current;
        }
        const next = new Set(current);
        next.delete(authorId);
        return next;
      });
      applyFollowingDelta(-1);
      void unfollowUser(authorId).then((ok) => {
        if (ok) {
          return;
        }
        applyFollowingDelta(1);
        setFollowedAuthorIds((current) => new Set(current ?? []).add(authorId));
      });
    };
    Alert.alert(`Unfollow ${displayName}?`, undefined, [
      { style: 'cancel', text: 'Cancel' },
      { onPress: unfollow, style: 'destructive', text: 'Unfollow' },
    ]);
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
    setIsLoadingMore(false);
    // A pull is a request for current numbers on the articles too.
    resetNewsReactions();
    void (async () => {
      try {
        const page = await readFirstPage();
        if (token !== loadTokenRef.current) {
          return;
        }
        setFeed(page);
        setStatus('ready');
        lastLoadedAtRef.current = Date.now();
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
  }, [readFirstPage, resetNewsReactions]);

  /*
    PAGING TWO SOURCES AS ONE. The merged list stops at the horizon — the
    newest "oldest loaded row" of any source that still has more — so the end
    of the list is always the point where ONE source has run out of loaded
    rows. Scrolling to it reads that source's next page (`sourcesToAdvance`).
    If the page lands entirely below the other source's horizon the list does
    not grow, `onEndReached` would not fire again, and the feed would stall; so
    the read repeats (bounded) until something new is visible or both sources
    are exhausted.

    Results are APPENDED to whatever the state is when they land rather than
    replacing it, so a delete or block made mid-read is not undone.
  */
  const handleLoadMore = useCallback(() => {
    if (loadingMoreRef.current || status !== 'ready' || sourcesToAdvance(feedRef.current).length === 0) {
      return;
    }
    const token = loadTokenRef.current;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);

    void (async () => {
      let working: MixedFeedState = feedRef.current;
      const visibleBefore = mergeMixedFeed(working).length;
      const addedPosts: FeedItem[] = [];
      const addedNews: NewsItem[] = [];
      try {
        for (let round = 0; round < MAX_ADVANCE_ROUNDS; round += 1) {
          const advance = sourcesToAdvance(working);
          if (advance.length === 0) {
            break;
          }
          const next: MixedFeedState = { ...working };
          await Promise.all(advance.map(async (which: MixedFeedSource) => {
            if (which === 'posts') {
              // The cursor is the last row's ACTIVITY time, not its post's
              // creation time — a reposted row sorts on when it was reposted.
              const cursor = working.posts[working.posts.length - 1]?.activityAt;
              try {
                const page = cursor ? await readPostsRef.current(cursor) : [];
                next.posts = [...next.posts, ...page];
                addedPosts.push(...page);
                next.postsDone = page.length < PAGE_SIZE;
              } catch {
                // Keep what's loaded and stop paging this source.
                next.postsDone = true;
              }
              return;
            }
            try {
              const page = working.newsCursor ? await readNewsRef.current(working.newsCursor) : null;
              const pageItems = page?.items ?? [];
              next.news = [...next.news, ...pageItems];
              addedNews.push(...pageItems);
              next.newsCursor = page?.nextCursor ?? null;
              next.newsDone = pageItems.length === 0 || !page?.nextCursor;
            } catch {
              next.newsDone = true;
            }
          }));
          working = next;
          if (token !== loadTokenRef.current) {
            return;
          }
          if (mergeMixedFeed(working).length > visibleBefore) {
            break;
          }
        }
        if (token !== loadTokenRef.current) {
          return;
        }
        const final = working;
        setFeed((current) => {
          // Pages can re-return a row (the posts read over-fetches across its two
          // halves, and a delete can pull the cursor back). Key-dedupe on append.
          const seenPosts = new Set(current.posts.map((item) => item.key));
          const seenNews = new Set(current.news.map((item) => item.id));
          return {
            posts: [...current.posts, ...addedPosts.filter((item) => !seenPosts.has(item.key))],
            postsDone: final.postsDone,
            news: [...current.news, ...addedNews.filter((item) => !seenNews.has(item.id))],
            newsCursor: final.newsCursor,
            newsDone: final.newsDone,
          };
        });
      } finally {
        if (token === loadTokenRef.current) {
          loadingMoreRef.current = false;
          setIsLoadingMore(false);
        }
      }
    })();
  }, [status]);

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

  /*
    A show's feed only: the For you / Following / <show> source chips, as the
    list's first row. Composing moved to the header's "+ POST" (Figma 6731:14459).
    Closes with the same 4pt `gray100` band every post card closes with.
  */
  const showSourceHeader = (
    <View
      style={[
        styles.composeSection,
        {
          borderBottomColor: theme.colors.gray100,
          // Only while the list is EMPTY. Once posts exist, the FIRST CELL draws
          // this band (see renderItem): Android lays cell 0 over the header's
          // bottom edge, and anything drawn from the header's side got shaved by
          // the cell's background.
          borderBottomWidth: rows.length > 0 ? 0 : 4,
        },
      ]}
      testID={`${testID}-compose-divider`}
    >
      {feedShow ? (
        <View style={styles.sourceChips} testID={`${testID}-source-chips`}>
          <PillButton
            label="For you"
            labelRole="caption"
            onPress={() => selectSource('forYou')}
            selected={source === 'forYou'}
            testID={`${testID}-source-for-you`}
            tone="filled"
            uppercase
          />
          <PillButton
            label="Following"
            labelRole="caption"
            onPress={() => selectSource('following')}
            selected={source === 'following'}
            testID={`${testID}-source-following`}
            tone="filled"
            uppercase
          />
          <PillButton
            label={feedShow.shortTitle}
            labelRole="caption"
            uppercase
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

  const renderHubPage = (tab: SocialTab, page: CollapsiblePageProps) => {
    if (tab === 'yourPosts') {
      if (!visitedTabs.has(tab)) {
        return <View style={styles.safeArea} testID={`${testID}-your-posts-placeholder`} />;
      }
      return <YourPostsPage page={page} scrollRef={yourPostsScrollRef} testID={`${testID}-your-posts`} />;
    }
    if (tab === 'events') {
      if (!visitedTabs.has(tab)) {
        return <View style={styles.safeArea} testID={`${testID}-events-placeholder`} />;
      }
      return <EventsPage page={page} scrollRef={eventsScrollRef} testID={`${testID}-events`} />;
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
          data={rows}
          // Keyed on the ROW, not the post: the same post can legitimately appear
          // twice — once on its own, once as somebody's repost.
          keyExtractor={(row: ForYouRow) => row.key}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
          ListHeaderComponent={feedShow ? showSourceHeader : null}
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
          renderItem={({ item: row, index }: { item: ForYouRow; index: number }) => (
            <>
              {/*
                The composer's closing band, drawn BY THE FIRST CELL rather than by
                the header above it: cell 0 paints over the header's bottom edge on
                Android, so anything the header drew on the seam was shaved the
                moment posts loaded. The 8pt bottom margin plus the card's own 8pt
                top inset makes the 16pt under-composer gap (Figma 4299:94902).
              */}
              {index === 0 && feedShow ? (
                <View
                  style={{
                    backgroundColor: theme.colors.gray100,
                    height: 4,
                    marginBottom: 8,
                  }}
                  testID={`${testID}-first-cell-rule`}
                />
              ) : null}
              {row.kind === 'news' ? (
                // Figma 6642:10973 / 6642:11002: a story with art gets the large
                // image; one without is the text row.
                <NewsArticleRow
                  item={row.news}
                  lead={Boolean(row.news.imageUrl)}
                  liked={isNewsLiked(row.news.id)}
                  reposted={isNewsReposted(row.news.id)}
                  testID={`${testID}-news-${row.news.id}`}
                  thread={newsReactions.threads.get(row.news.id) ?? null}
                />
              ) : (
                <>
                  {/*
                    The card below carries the ORIGINAL author's name and avatar, so
                    without this line a reposted row reads as though the reposter
                    wrote it. Same component Your posts uses.
                  */}
                  {row.item.repostedBy ? (
                    <RepostAttribution
                      name={reposterAttributionName(row.item.repostedBy, viewerHandle)}
                      testID={`${testID}-repost-attribution`}
                    />
                  ) : null}
                  <PostCard
                    accessToken={accessToken}
                    apiBaseUrl={apiBaseUrl}
                    isFollowingAuthor={
                      followedAuthorIds ? followedAuthorIds.has(row.item.post.authorId) : null
                    }
                    onAuthorBlocked={handleAuthorBlocked}
                    onFollowAuthor={handleFollowAuthor}
                    onUnfollowAuthor={handleUnfollowAuthor}
                    onPressCard={handleOpenCard}
                    eventBadgeMode={source === 'show' ? 'booth' : 'show'}
                    onRequestDelete={requestDelete}
                    post={row.item.post}
                    testID={`${testID}-post`}
                  />
                </>
              )}
            </>
          )}
          testID={`${testID}-list`}
        />
    );
  };

  return (
    <SocialHubFrame
      activeTab={activeTab}
      hubHeaderHeight={hubHeaderHeight}
      listTopOffset={listTopOffset}
      onChange={selectTab}
      onPageScroll={handlePageScroll}
      order={SOCIAL_TAB_ORDER}
      pageRefs={pageRefs}
      renderPage={renderHubPage}
      scrollY={headerScrollY}
      tabs={SOCIAL_TABS}
      testID={testID}
      trailing={{
        kind: 'social',
        onCompose: openComposer,
        onOpenNotifications: openNotifications,
        unreadCount,
      }}
    >
      {deleteConfirmSheet}
    </SocialHubFrame>
  );
}

/**
 * Social's page state: the active page, which pages have mounted (lazy, so
 * opening Social reads only the page in view), the outer-strip hand-off, and the
 * `/social?tab=` deep link.
 */
function useSocialHubTabs(order: readonly SocialTab[], initialTab: SocialTab, requestedTab?: SocialTab) {
  const firstTab = order.includes(initialTab) ? initialTab : order[0];
  const [activeTab, setActiveTab] = useState<SocialTab>(firstTab);
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SocialTab>>(
    () => new Set<SocialTab>([order[0], firstTab]),
  );
  const selectTab = useCallback((next: SocialTab) => {
    setActiveTab(next);
    setVisitedTabs((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);
  // A param change while Social is mounted (another `/social?tab=` link) switches pages.
  useEffect(() => {
    if (requestedTab && order.includes(requestedTab)) {
      selectTab(requestedTab);
    }
  }, [order, requestedTab, selectTab]);
  // Revealed from the outer strip: land on the NEAR edge (FOR YOU from Scan, EVENTS
  // coming back from the next tab), so the strip reads as one row of pages.
  useTabLanding('social', (edge) => {
    const page = innerPageForLanding(order, edge);
    if (page) {
      selectTab(page);
    }
  });
  // Lets the outer pager hand a drag past FOR YOU back to Scan, and past EVENTS on to the next tab.
  useTabPagerInnerPosition({ count: order.length, index: Math.max(order.indexOf(activeTab), 0) });
  return { activeTab, selectTab, visitedTabs };
}

type SocialHubFrameProps = {
  activeTab: SocialTab;
  children?: ReactNode;
  hubHeaderHeight: number;
  listTopOffset: number;
  onChange: (next: SocialTab) => void;
  onPageScroll?: (page: SocialTab, event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  order: readonly SocialTab[];
  pageRefs: Partial<Record<SocialTab, { readonly current: CollapsibleScrollTarget | null }>>;
  renderPage: (tab: SocialTab, page: CollapsiblePageProps) => ReactNode;
  scrollY: Animated.Value;
  tabs: readonly PageTab<SocialTab>[];
  testID: string;
  trailing: HomeHeaderTrailing;
};

/** Social's chrome: the floating header over the page pager and its underline rail. */
function SocialHubFrame({
  activeTab,
  children,
  hubHeaderHeight,
  listTopOffset,
  onChange,
  onPageScroll,
  order,
  pageRefs,
  renderPage,
  scrollY,
  tabs,
  testID,
  trailing,
}: SocialHubFrameProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  return (
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
        onChange={onChange}
        onPageScroll={onPageScroll}
        order={order}
        pageRefs={pageRefs}
        // Same height as the header, so nothing collapses and the tabs stay put.
        pinnedTopInset={hubHeaderHeight}
        renderPage={renderPage}
        scrollY={scrollY}
        tabBar={
          <View style={{ backgroundColor: theme.colors.gray0 }}>
            <PageTabs
              // Figma 6642:11165: the 2026-11 underline rail.
              onChange={onChange}
              tabs={tabs}
              testID={`${testID}-tabs`}
              uppercase
              value={activeTab}
              variant="underline"
            />
          </View>
        }
        testID={`${testID}-pager`}
        value={activeTab}
      />
      {/* The blur/fade under the tab bar is drawn by the pager for every tab
          page (`TabBarBackdrop`), so it is identical on all of them. */}
      {/*
        AFTER the pager so tree order paints it on top, and so UIKit's
        `subviews[0]` walk still reaches the scroller for minimize-on-scroll.
      */}
      <HomeHeader
        floating
        scrollRestOffset={listTopOffset}
        scrollY={scrollY}
        testID={`${testID}-header`}
        // Figma 6642:5420: lockup centred, messages + bell on the right.
        trailing={trailing}
      />
      {children}
    </SafeAreaView>
  );
}

/**
 * Social for a guest: EVENTS only, with the same header and rail. The feed pages
 * are left out rather than shown as sign-in walls, so a swipe never lands on a
 * dead page; messages and the bell open sign-in.
 */
export function GuestSocialScreen({ testID = 'feed' }: { testID?: string }) {
  const insets = useSafeAreaInsets();
  const { openLogin } = useGuestGate();
  const { activeTab, selectTab } = useSocialHubTabs(GUEST_SOCIAL_TAB_ORDER, 'events');
  const eventsScrollRef = useRef<CollapsibleScrollTarget | null>(null);
  const pageRefs = useMemo(() => ({ events: eventsScrollRef }), []);
  const listTopOffset = Platform.OS === 'ios' ? -insets.top : 0;
  const headerScrollY = useRef(new Animated.Value(listTopOffset)).current;
  const hubHeaderHeight = insets.top + HOME_HEADER_BAR_HEIGHT + TOOLBAR_TO_TABS_GAP;

  return (
    <SocialHubFrame
      activeTab={activeTab}
      hubHeaderHeight={hubHeaderHeight}
      listTopOffset={listTopOffset}
      onChange={selectTab}
      order={GUEST_SOCIAL_TAB_ORDER}
      pageRefs={pageRefs}
      renderPage={(_tab, page) => (
        <EventsPage page={page} scrollRef={eventsScrollRef} testID={`${testID}-events`} />
      )}
      scrollY={headerScrollY}
      tabs={GUEST_SOCIAL_TABS}
      testID={testID}
      trailing={{
        kind: 'social',
        onCompose: openLogin,
        onOpenNotifications: openLogin,
        unreadCount: 0,
      }}
    />
  );
}

const SOURCE_CHIP_ICON_SIZE = 16;

const styles = StyleSheet.create({

  // The filled pill itself (Figma 4299:94902): 8 padding around a 24pt avatar
  // makes the 40pt-tall capsule; fill + radius come from the theme inline.
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
