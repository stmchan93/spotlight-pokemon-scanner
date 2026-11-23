import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { useFeedShow } from '@/features/events/hooks/use-active-show';
import {
  deletePost,
  fetchEventPosts,
  fetchFollowingFeed,
  fetchGlobalFeed,
  fetchGlobalFeedItems,
} from '@/features/social/social-service';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { getFeedRefreshVersion, signalFeedNeedsRefresh } from '@/features/social/screens/new-post-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useFocusEffect: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => {
  // The screen reads `fetchGlobalFeedItems` (posts + reposts as feed rows), but
  // every fixture in this file is a plain post list. Delegating keeps those
  // fixtures driving the screen unchanged; the repost-specific tests override
  // `fetchGlobalFeedItems` directly to inject a reposted row.
  const fetchGlobalFeed = jest.fn();
  return {
  blockUser: jest.fn(async () => true),
  deletePost: jest.fn(async () => true),
  fetchFollowingFeed: jest.fn(),
  fetchEventPosts: jest.fn(async () => []),
  feedItemFromPost: (post: { id: string; createdAt: string }) => ({
    key: `post:${post.id}`,
    post,
    repostedBy: null,
    repostedById: null,
    repostedAt: null,
    activityAt: post.createdAt,
  }),
  fetchGlobalFeed,
  fetchGlobalFeedItems: jest.fn(async (...args: unknown[]) => {
    const posts = (await (fetchGlobalFeed as jest.Mock)(...args)) ?? [];
    return (posts as { id: string; createdAt: string }[]).map((post) => ({
      key: `post:${post.id}`,
      post,
      repostedBy: null,
      repostedAt: null,
      activityAt: post.createdAt,
    }));
  }),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
  repostPost: jest.fn(async () => true),
  unrepostPost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  addComment: jest.fn(async () => ({ ok: false, reason: 'nope' })),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
  };
});

// No show chip unless a test puts one on.
jest.mock('@/features/social/screens/news-page', () => {
  const { View } = require('react-native');
  return { NewsPage: ({ testID }: { testID: string }) => <View testID={testID} /> };
});

jest.mock('@/features/social/screens/market-watch-page', () => {
  const { View } = require('react-native');
  return { MarketWatchPage: ({ testID }: { testID: string }) => <View testID={testID} /> };
});

jest.mock('@/features/events/hooks/use-active-show', () => ({
  useFeedShow: jest.fn(() => null),
}));

const mockFollowUser = jest.fn(async (_authorId: string) => true);
jest.mock('@/features/profile/profile-service', () => ({
  ...jest.requireActual('@/features/profile/profile-service'),
  fetchFollowing: jest.fn(async () => []),
  followUser: (authorId: string) => mockFollowUser(authorId),
}));

/** The id `AuthProvider` signs in as under NODE_ENV=test. */
const MY_USER_ID = '00000000-0000-0000-0000-000000000001';

function buildPost(overrides: { id: string } & Record<string, unknown>) {
  return {
    authorId: `author-${overrides.id}`,
    author: { displayName: `Collector ${overrides.id}`, handle: `c${overrides.id}`, avatarUrl: null, isVerified: false },
    body: `Post ${overrides.id}`,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    media: [],
    ...overrides,
  };
}

const push = jest.fn();

/** Market reads the Social tab must never make. */
const getTopMovers = jest.fn<Promise<unknown>, [number?]>();

const fetchMetaPulse = jest.fn();
const fetchHotCards = jest.fn();
const fetchSetSpotlight = jest.fn();
const fetchNewsFeed = jest.fn();
const fetchMetaExposure = jest.fn();
const fetchCalendar = jest.fn();

function renderFeed() {
  return renderWithProviders(<FeedScreen />, {
    spotlightRepository: createTestSpotlightRepository({
      getTopMovers: getTopMovers as unknown as () => Promise<never>,
      fetchMetaPulse,
      fetchHotCards,
      fetchSetSpotlight,
      fetchNewsFeed,
      fetchMetaExposure,
      fetchCalendar,
    }),
  });
}

describe('FeedScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '1', body: 'Feed post' }),
    ]);
    getTopMovers.mockRejectedValue(new Error('no movers'));
    fetchMetaPulse.mockResolvedValue(null);
    fetchHotCards.mockResolvedValue(null);
    fetchSetSpotlight.mockResolvedValue(null);
    fetchNewsFeed.mockResolvedValue(null);
    fetchMetaExposure.mockResolvedValue(null);
    fetchCalendar.mockResolvedValue(null);
    // The hook logs the rejection; keep the default-rejecting reads quiet.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  describe('following an author from a post', () => {
    function FollowingCountProbe() {
      const { useAuth } = require('@/providers/auth-provider');
      const { Text } = require('react-native');
      const { currentUser } = useAuth();
      return <Text testID="probe-following-count">{String(currentUser?.followingCount ?? 0)}</Text>;
    }

    function renderFeedWithProbe() {
      return renderWithProviders(
        <>
          <FeedScreen />
          <FollowingCountProbe />
        </>,
        {
          spotlightRepository: createTestSpotlightRepository({
            getTopMovers: getTopMovers as unknown as () => Promise<never>,
            fetchMetaPulse,
            fetchHotCards,
            fetchSetSpotlight,
            fetchNewsFeed,
            fetchMetaExposure,
            fetchCalendar,
          }),
        },
      );
    }

    it('bumps your own following count on the tap', async () => {
      mockFollowUser.mockResolvedValue(true);
      renderFeedWithProbe();
      const before = Number((await screen.findByTestId('probe-following-count')).props.children);

      fireEvent.press(await screen.findByTestId('feed-post-follow-button'));

      await waitFor(() => expect(mockFollowUser).toHaveBeenCalledWith('author-1'));
      expect(screen.getByTestId('probe-following-count').props.children).toBe(String(before + 1));
    });

    it('puts the count back when the follow fails', async () => {
      mockFollowUser.mockResolvedValue(false);
      renderFeedWithProbe();
      const before = Number((await screen.findByTestId('probe-following-count')).props.children);

      fireEvent.press(await screen.findByTestId('feed-post-follow-button'));

      await waitFor(() => expect(screen.getByTestId('probe-following-count').props.children).toBe(String(before)));
      expect(mockFollowUser).toHaveBeenCalled();
    });
  });

  // Home is ONE feed: every visible post, newest first. The screen carried a
  // Following / Global switch until it became the Home tab; this asserts the
  // remaining read is the global one and that the follow graph no longer gates
  // what you see, which is the whole behavioural change.
  it('reads the global feed, and only the global feed, on first load', async () => {
    renderFeed();

    await waitFor(() => {
      expect(screen.getByText('Feed post')).toBeTruthy();
    });
    expect(fetchGlobalFeed).toHaveBeenCalled();
    expect(fetchFollowingFeed).not.toHaveBeenCalled();
    // No switch to press any more.
    expect(screen.queryByTestId('feed-segment-tab-global')).toBeNull();
    expect(screen.queryByTestId('feed-segment-tab-following')).toBeNull();
    // No show on and none saved: no chip row either.
    expect(screen.queryByTestId('feed-source-chips')).toBeNull();
  });

  describe('show chip', () => {
    const show = { id: 'hawaii-2026-10', shortTitle: 'Spotlight Hawaii' };

    beforeEach(() => {
      (useFeedShow as jest.Mock).mockReturnValue(show);
    });

    afterEach(() => {
      (useFeedShow as jest.Mock).mockReturnValue(null);
    });

    it('offers For you · Following · the show while a show is on', async () => {
      renderFeed();
      await screen.findByText('Feed post');

      expect(screen.getByTestId('feed-source-for-you')).toBeTruthy();
      expect(screen.getByTestId('feed-source-following')).toBeTruthy();
      // Chips are capitals app-wide (Figma 5938:13960).
      expect(within(screen.getByTestId('feed-source-show')).getByText('SPOTLIGHT HAWAII')).toBeTruthy();
    });

    it("swaps the list for the show's feed and composes into it", async () => {
      (fetchEventPosts as jest.Mock).mockResolvedValue([
        buildPost({ id: 'floor', body: 'From the floor', eventId: show.id, boothVendorId: null }),
      ]);
      renderFeed();
      await screen.findByText('Feed post');

      fireEvent.press(screen.getByTestId('feed-source-show'));

      expect(await screen.findByText('From the floor')).toBeTruthy();
      expect(screen.queryByText('Feed post')).toBeNull();
      expect(fetchEventPosts).toHaveBeenCalledWith(show.id, 20, { before: undefined });

      fireEvent.press(screen.getByTestId('feed-compose-prompt'));
      expect(push).toHaveBeenCalledWith({ pathname: '/new-post', params: { eventId: show.id } });
    });

    it('reads the following feed from its chip', async () => {
      (fetchFollowingFeed as jest.Mock).mockResolvedValue([buildPost({ id: 'f', body: 'Followed post' })]);
      renderFeed();
      await screen.findByText('Feed post');

      fireEvent.press(screen.getByTestId('feed-source-following'));
      expect(await screen.findByText('Followed post')).toBeTruthy();
    });
  });

  /*
    REPOSTS BELONG IN THE FEED, AS THEIR OWN ROWS.

    A repost used to be invisible everywhere except the reposter's profile: the
    feed read `posts` alone and never touched `post_reposts`. The row carries the
    ORIGINAL author's card with a "<name> reposted" line above it, so nothing is
    misattributed to whoever passed it on.
  */
  describe('reposts in the feed', () => {
    const original = buildPost({ id: 'original', body: 'Original post' });
    // These tests replace the delegating implementation. `clearAllMocks` only
    // clears CALLS, not implementations, so it has to be put back by hand or
    // every later test in this file inherits the repost fixture.
    const delegateToGlobalFeed = (fetchGlobalFeedItems as jest.Mock).getMockImplementation();

    afterEach(() => {
      (fetchGlobalFeedItems as jest.Mock).mockImplementation(delegateToGlobalFeed!);
    });

    function mockFeedWithRepost() {
      (fetchGlobalFeedItems as jest.Mock).mockResolvedValue([
        {
          key: 'repost:original:reposter-1',
          post: original,
          repostedBy: {
            displayName: 'Misty',
            handle: 'misty',
            avatarUrl: null,
            isVerified: false,
          },
          repostedAt: '2026-05-02T00:00:00.000Z',
          activityAt: '2026-05-02T00:00:00.000Z',
        },
        {
          key: 'post:original',
          post: original,
          repostedBy: null,
          repostedAt: null,
          activityAt: original.createdAt,
        },
      ]);
    }

    it('captions a reposted row with who passed it on', async () => {
      mockFeedWithRepost();

      renderFeed();

      await waitFor(() => {
        expect(screen.getByTestId('feed-repost-attribution')).toBeTruthy();
      });
      expect(screen.getByText('Misty reposted')).toBeTruthy();
    });

    // The repost and the original are DIFFERENT rows for the SAME post — keyed
    // on the post id alone, React would drop one as a duplicate key.
    it('renders the repost and the original as two separate rows', async () => {
      mockFeedWithRepost();

      renderFeed();

      await waitFor(() => {
        expect(screen.getAllByTestId('feed-post-body')).toHaveLength(2);
      });
      // Exactly one of them is captioned.
      expect(screen.getAllByTestId('feed-repost-attribution')).toHaveLength(1);
    });
  });

  /*
    THE COMPOSE PROMPT ROW IS HOW YOU POST NOW. The header's `+` bubble was
    invisible to users as a way to write — nobody read the glass symbol as
    "new post" — so a Facebook-style "What's on your mind?" row (avatar + gray
    placeholder, the same prompt Portfolio's empty Activity draws) sits
    permanently at the top of the list and pushes the same composer route.
  */
  it('renders the compose prompt above the posts and opens the composer from it', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '1', body: 'Feed post' }),
      buildPost({ id: '2', body: 'Second post' }),
    ]);

    renderFeed();
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // ABOVE the feed: a `ListHeaderComponent`, so it precedes every post row in
    // tree order — asserted across prompt and bodies together, in one query.
    const rows = screen.getAllByTestId(/^feed-(compose-prompt|post-body)$/);
    expect(rows).toHaveLength(3);
    expect(rows[0].props.testID).toBe('feed-compose-prompt');

    expect(screen.getByText('WHAT’S ON YOUR MIND?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('feed-compose-prompt'));
    expect(push).toHaveBeenCalledWith('/new-post');
  });

  /*
    On Android, cell 0 paints over the header's fractional bottom edge, so
    EVERY line drawn from the header's side — sibling view, border, even a
    zIndex'd border — got shaved once posts loaded. The band therefore has two
    owners: the header's border while the list is empty, and the first cell
    itself once posts exist. This pins both halves, at the 4pt `gray100` band
    the Figma (4299:94902) separates sections with.
  */
  it('hands the compose band to the first cell once posts load', async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // The header's own border is OFF — a band here would be shaved on Android
    // (and doubled everywhere else).
    const section = screen.getByTestId('feed-compose-divider');
    const style = StyleSheet.flatten(section.props.style);
    expect(style.borderBottomWidth).toBe(0);
    expect(style.width).toBe('100%');
    expect(within(section).getByTestId('feed-compose-prompt')).toBeTruthy();

    // The first cell draws the band itself, in the same View form as the
    // card's bottom band, so the two rasterize identically. Its 4pt bottom
    // margin + the card's 12pt top inset is the 16pt under-composer gap.
    const band = screen.getByTestId('feed-first-cell-rule');
    const bandStyle = StyleSheet.flatten(band.props.style);
    expect(bandStyle.height).toBe(4);
    expect(bandStyle.backgroundColor).toBe('#F2F2F2');
    expect(bandStyle.marginBottom).toBe(8);
  });

  it('keeps the compose band as a header border while the feed is empty', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([]);
    renderFeed();
    await waitFor(() => expect(screen.getByTestId('feed-compose-divider')).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('feed-first-cell-rule')).not.toBeOnTheScreen());

    const style = StyleSheet.flatten(screen.getByTestId('feed-compose-divider').props.style);
    expect(style.borderBottomWidth).toBe(4);
    expect(style.borderBottomColor).toBe('#F2F2F2');
  });

  describe('the Social / News / Market Watch tabs', () => {
    it('renders the three tabs with Social selected', async () => {
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

      expect(screen.getByText('SOCIAL')).toBeTruthy();
      expect(screen.getByText('NEWS')).toBeTruthy();
      expect(screen.getByText('MARKET WATCH')).toBeTruthy();
      expect(screen.getByTestId('feed-tabs-tab-social').props.accessibilityState.selected).toBe(true);
    });

    // Figma 6597:3462: left on the 16 gutter, active tab marked by weight and
    // colour only — no underline, no rail.
    it('left-aligns the tab row with an underline under the active tab and a rail (Figma 6597:3589)', async () => {
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

      expect(screen.getByTestId('feed-tabs-rail')).toBeTruthy();
      const underline = StyleSheet.flatten(
        screen.getByTestId('feed-tabs-tab-social-underline').props.style,
      );
      expect(underline.backgroundColor).not.toBe('transparent');
      const inactive = StyleSheet.flatten(screen.getByTestId('feed-tabs-tab-news-underline').props.style);
      expect(inactive.backgroundColor).toBe('transparent');

      // Active darker than inactive.
      const social = StyleSheet.flatten(screen.getByText('SOCIAL').props.style);
      const news = StyleSheet.flatten(screen.getByText('NEWS').props.style);
      expect(social.color).not.toBe(news.color);
      expect(social.fontSize).toBe(13);
    });

    it('mounts News and Market Watch on their first visit, not before', async () => {
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      expect(screen.queryByTestId('feed-news')).toBeNull();
      expect(screen.queryByTestId('feed-market')).toBeNull();

      fireEvent.press(screen.getByTestId('feed-tabs-tab-news'));
      expect(screen.getByTestId('feed-news')).toBeTruthy();
      expect(screen.queryByTestId('feed-market')).toBeNull();

      fireEvent.press(screen.getByTestId('feed-tabs-tab-market'));
      expect(screen.getByTestId('feed-market')).toBeTruthy();
      // Visited pages stay mounted so a swipe back keeps their place.
      expect(screen.getByTestId('feed-news')).toBeTruthy();
    });

    it('keeps Social to posts: no market blocks, and none of their reads', async () => {
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

      for (const block of ['top-trends', 'meta-pulse', 'hot-cards', 'coming-up', 'card-news']) {
        expect(screen.queryByTestId(`feed-${block}`)).toBeNull();
      }
      for (const read of [getTopMovers, fetchMetaPulse, fetchMetaExposure, fetchHotCards, fetchCalendar, fetchNewsFeed]) {
        expect(read).not.toHaveBeenCalled();
      }
    });
  });

  it('shows an empty state when there are no posts', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([]);

    renderFeed();

    await waitFor(() => {
      expect(screen.getByTestId('feed-empty')).toBeTruthy();
    });
    // One message now: the "follow collectors" copy only made sense while an
    // empty feed could mean "you follow nobody" rather than "there is nothing".
    expect(screen.getByText('No posts yet. Check back soon.')).toBeTruthy();
  });

  // The top bar is the feed's chrome (Figma 3505:14521) and is pinned above the
  // list, so every one of its destinations stays reachable with an EMPTY feed —
  // the case the old in-list composer row was there to cover.
  it('keeps the header actions reachable when there are no posts', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([]);

    renderFeed();

    await waitFor(() => {
      expect(screen.getByTestId('feed-empty')).toBeTruthy();
    });

    // Composing is NOT a header action any more — the bar's `+` was invisible
    // to users and the compose prompt row replaced it — but it must survive an
    // empty feed just the same. It does, because a `ListHeaderComponent`
    // renders above `ListEmptyComponent`, not instead of it.
    fireEvent.press(screen.getByTestId('feed-compose-prompt'));
    expect(push).toHaveBeenCalledWith('/new-post');

    // No search on Social (Figma 6597:3462).
    expect(screen.queryByTestId('feed-header-search')).toBeNull();

    fireEvent.press(screen.getByTestId('feed-header-notifications'));
    expect(push).toHaveBeenCalledWith('/notifications');

    /*
      HOME KEEPS THE BELL AND THE `+`. The bar took a `trailing` variant so
      Collection could draw the profile toolbar's edit/share pair (Figma
      3670:47454) out of the SAME component, and Collection genuinely lost its
      bell and `+` in that change — so Home is now the only place either lives.
      Asserting the profile pair's ABSENCE here is what keeps the variant from
      leaking across.
    */
    expect(screen.queryByTestId('feed-header-edit')).toBeNull();
    expect(screen.queryByTestId('feed-header-share')).toBeNull();
  });

  // The bar FLOATS and stays pinned whole; nothing in it moves on scroll any
  // more (the fading search pill retired with Figma 4299:94902 — search is now
  // a bubble in the trailing group). This has been wrong in every direction —
  // solid buttons stacked above the list, then one bar that scrolled away
  // whole — so the shape is pinned here.
  it('keeps the bar pinned over the list with its trailing actions live', async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // Floating chrome: absolutely positioned, painted over the list.
    const bar = screen.getByTestId('feed-header');
    expect(StyleSheet.flatten(bar.props.style).position).toBe('absolute');

    push.mockClear();
    fireEvent.press(screen.getByTestId('feed-header-notifications'));
    expect(push).toHaveBeenLastCalledWith('/notifications');

    // The retired full-width pill must not come back on Home.
    expect(screen.queryByTestId('feed-header-search-motion')).toBeNull();
  });

  /*
    NO RULE AT ALL — deliberately, and this test is inverted rather than deleted
    so the removal is visible to whoever comes looking for the hairline.

    The feed used to render one as its first list row (`HomeHeaderRule`), on the
    reading that the hairline belonged to the page rather than to the floating
    bar. The live frame (Figma "Home" 4299:94902) draws no line under the
    toolbar: the bar is floating glass that is meant to hover, and the only
    separators on Home are the 4pt bands each section closes with. The bar's
    own bottom padding plus the composer section's top inset is the whole gap.
  */
  it('draws no hairline under the bar — not in the list, not in the bar', async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    expect(screen.queryByTestId('feed-header-rule')).toBeNull();
    expect(within(screen.getByTestId('feed-header')).queryByTestId('feed-header-rule')).toBeNull();
    expect(within(screen.getByTestId('feed-list')).queryByTestId('feed-header-rule')).toBeNull();
  });

  it('heads Social with messages + bell right and no menu, Ask Ekalight or search (Figma 6642:5420)', async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    expect(screen.getByTestId('feed-header-messages')).toBeTruthy();
    expect(screen.getByTestId('feed-header-notifications')).toBeTruthy();
    expect(screen.queryByTestId('feed-header-menu')).toBeNull();
    expect(screen.queryByTestId('feed-header-assistant')).toBeNull();
    expect(screen.queryByTestId('feed-header-search')).toBeNull();
  });

  /*
    Engagement counts (`posts.comment_count`, `like_count`) are read at fetch
    time and never pushed, so a feed left open goes stale silently. Reported from
    two accounts side by side: one had written eight comments while the other
    still showed "1 comment" on the same post, and it only corrected after
    opening the thread and backing out.

    `useFocusEffect` is mocked to a bare `jest.fn()` in this file, so these drive
    the effect by invoking the callback it was handed — which is also the only
    way to control WHEN focus happens relative to the clock.
  */
  describe('refetching a stale feed on focus', () => {
    /** Run the callback the screen most recently passed to `useFocusEffect`. */
    async function triggerFocus() {
      const calls = (useFocusEffect as jest.Mock).mock.calls;
      const effect = calls[calls.length - 1]?.[0] as (() => void) | undefined;
      await act(async () => {
        effect?.();
      });
    }

    it('refetches when the feed has gone stale, without blanking what is on screen', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      expect(fetchGlobalFeed).toHaveBeenCalledTimes(1);

      // Come back well past the staleness window.
      nowSpy.mockReturnValue(60_000);
      (fetchGlobalFeed as jest.Mock).mockResolvedValue([
        buildPost({ id: '1', body: 'Feed post, now with 8 comments' }),
      ]);
      await triggerFocus();
      // RELEASE the clock before waiting. `waitFor` measures its own timeout
      // against `Date.now()`, so leaving it frozen makes the wait unable to
      // advance — which showed up as this test passing alone and flaking under
      // full-suite load. The staleness decision has already been made by now.
      nowSpy.mockRestore();

      await waitFor(() => expect(fetchGlobalFeed).toHaveBeenCalledTimes(2));
      // QUIET: the previous page stayed up throughout. If this went through
      // `loadFeed` the list would have been emptied and a spinner shown, which
      // is right for a cold open and wrong for coming back to a tab.
      await waitFor(() =>
        expect(screen.getByText('Feed post, now with 8 comments')).toBeTruthy(),
      );
    });

    it('does not refetch when the feed is still fresh', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      expect(fetchGlobalFeed).toHaveBeenCalledTimes(1);

      // Straight back inside the window — a tab bounce, which is the most
      // common navigation in this app and must not cost a round trip.
      nowSpy.mockReturnValue(5_000);
      await triggerFocus();
      nowSpy.mockRestore();

      expect(fetchGlobalFeed).toHaveBeenCalledTimes(1);
    });

    it('still reloads immediately after composing, however fresh the feed is', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
      renderFeed();
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

      // Your own new post appearing at the top must never wait on a staleness
      // window — that would read as the post having failed.
      signalFeedNeedsRefresh();
      nowSpy.mockReturnValue(1_000);
      await triggerFocus();
      nowSpy.mockRestore();

      await waitFor(() => expect(fetchGlobalFeed).toHaveBeenCalledTimes(2));
    });
  });

  // Deleting your own post: the ⋯ affordance is on the card, but the confirm +
  // optimistic removal + rollback live on the screen that owns the list.
  describe('deleting your own post', () => {
    const myPost = () => buildPost({ id: 'mine', authorId: MY_USER_ID, body: 'My own post' });

    beforeEach(() => {
      (deletePost as jest.Mock).mockResolvedValue(true);
      (fetchGlobalFeed as jest.Mock).mockResolvedValue([
        myPost(),
        buildPost({ id: 'theirs', body: 'Someone else post' }),
      ]);
    });

    // Every post carries a ⋯ now — someone else's holds Report/Block — so what
    // this pins is that only YOUR ⋯ can reach the delete confirmation.
    it('only offers delete on the post you wrote', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      renderFeed();
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      expect(screen.getAllByTestId('feed-post-more-button')).toHaveLength(2);

      await act(async () => {
        fireEvent.press(
          within(screen.getByTestId('feed-post-theirs')).getByTestId('feed-post-more-button'),
        );
      });

      // Their ⋯ opens the safety menu, never the delete sheet. The menu is the
      // same `OptionsSheet` a comment row opens — a bare Report / Block /
      // Cancel list, not an OS alert.
      expect(screen.queryByTestId('feed-delete-confirm')).toBeNull();
      expect(alertSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('feed-post-options')).toBeTruthy();
      expect(screen.getByText('REPORT POST')).toBeTruthy();
      expect(screen.getByText('BLOCK COLLECTOR THEIRS')).toBeTruthy();
      expect(screen.getByTestId('feed-post-options-cancel')).toBeTruthy();
      alertSpy.mockRestore();
    });

    it('asks for confirmation before deleting anything', async () => {
      renderFeed();
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(
          within(screen.getByTestId('feed-post-mine')).getByTestId('feed-post-more-button'),
        );
      });

      expect(await screen.findByTestId('feed-delete-confirm')).toBeTruthy();
      // Still on screen, and nothing has been written.
      expect(screen.getByText('My own post')).toBeTruthy();
      expect(deletePost).not.toHaveBeenCalled();

      // Backing out leaves the post alone.
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-delete-confirm-cancel'));
      });
      expect(deletePost).not.toHaveBeenCalled();
      expect(screen.getByText('My own post')).toBeTruthy();
    });

    it('removes the post optimistically on confirm and leaves the rest of the feed alone', async () => {
      renderFeed();
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(
          within(screen.getByTestId('feed-post-mine')).getByTestId('feed-post-more-button'),
        );
      });
      await screen.findByTestId('feed-delete-confirm');
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-delete-confirm-confirm'));
      });

      await waitFor(() => expect(screen.queryByText('My own post')).not.toBeOnTheScreen());
      expect(deletePost).toHaveBeenCalledWith('mine');
      expect(screen.getByText('Someone else post')).toBeTruthy();
    });

    /*
      THE BUG THIS PINS. The feed and the Portfolio Activity tab each hold their
      own `FeedPost[]` — there is no shared post store — so removing the row
      here fixes only the list the delete was issued from. Activity's load is
      latched by `activityLoadedRef` and its refresh reloads inventory, not
      posts, so a post deleted from the feed stayed on the profile for the whole
      session with no way to clear it.

      Creating and reposting both bumped this counter already; deleting was the
      asymmetry. The screens compare the version on focus, which is what makes
      the deleted row disappear from Activity the next time it is looked at.
    */
    it('signals the other list so the deleted post cannot linger on the profile', async () => {
      const versionBefore = getFeedRefreshVersion();

      renderFeed();
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(
          within(screen.getByTestId('feed-post-mine')).getByTestId('feed-post-more-button'),
        );
      });
      await screen.findByTestId('feed-delete-confirm');
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-delete-confirm-confirm'));
      });

      await waitFor(() => {
        expect(getFeedRefreshVersion()).toBeGreaterThan(versionBefore);
      });
    });

    // The mirror image: the post is still there, so nothing may be told it went.
    it('does NOT signal a refresh when the delete failed', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      (deletePost as jest.Mock).mockResolvedValue(false);
      const versionBefore = getFeedRefreshVersion();

      renderFeed();
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(
          within(screen.getByTestId('feed-post-mine')).getByTestId('feed-post-more-button'),
        );
      });
      await screen.findByTestId('feed-delete-confirm');
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-delete-confirm-confirm'));
      });

      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());
      expect(getFeedRefreshVersion()).toBe(versionBefore);

      alertSpy.mockRestore();
    });

    it('puts the post back and tells the user when the delete fails', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      (deletePost as jest.Mock).mockResolvedValue(false);

      renderFeed();
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(
          within(screen.getByTestId('feed-post-mine')).getByTestId('feed-post-more-button'),
        );
      });
      await screen.findByTestId('feed-delete-confirm');
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-delete-confirm-confirm'));
      });

      // A failed delete must never leave the row gone: the post is restored...
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());
      // ...in its original position, above the other post.
      const bodies = screen.getAllByTestId('feed-post-body').map((node) => node.props.children);
      expect(bodies).toEqual(['My own post', 'Someone else post']);
      // ...and the user is told rather than left believing it worked.
      expect(alertSpy).toHaveBeenCalledWith(
        "Couldn't delete post",
        expect.stringContaining('still there'),
      );

      alertSpy.mockRestore();
    });
  });

  /*
    Blocking someone must clear EVERY row they are in, not just the card that was
    tapped. Reported: "I blocked someone but their reposts didn't get removed
    from the timeline until I refreshed" — a repost carries SOMEONE ELSE'S post,
    so filtering on `post.authorId` alone leaves it on screen.
  */
  describe('blocking', () => {
    // Same restore the repost tests need: replacing the delegating
    // implementation leaks into every later test in this file otherwise.
    const delegateToGlobalFeed = (fetchGlobalFeedItems as jest.Mock).getMockImplementation();

    afterEach(() => {
      (fetchGlobalFeedItems as jest.Mock).mockImplementation(delegateToGlobalFeed!);
    });

  it('drops the blocked person\'s posts AND their reposts immediately', async () => {
    const theirPost = buildPost({ id: 'theirs', body: 'Their own post', authorId: 'blocked-1' });
    const someoneElse = buildPost({ id: 'other', body: 'Unrelated post', authorId: 'author-other' });

    (fetchGlobalFeedItems as jest.Mock).mockResolvedValue([
      { key: 'post:theirs', post: theirPost, repostedBy: null, repostedById: null, repostedAt: null, activityAt: theirPost.createdAt },
      {
        key: 'repost:other:blocked-1',
        post: someoneElse,
        repostedBy: { displayName: 'Blocked One', handle: 'blocked1', avatarUrl: null, isVerified: false },
        repostedById: 'blocked-1',
        repostedAt: '2026-05-02T00:00:00.000Z',
        activityAt: '2026-05-02T00:00:00.000Z',
      },
      { key: 'post:other', post: someoneElse, repostedBy: null, repostedById: null, repostedAt: null, activityAt: someoneElse.createdAt },
    ]);

    renderFeed();
    await waitFor(() => expect(screen.getByText('Their own post')).toBeTruthy());
    // Their post, their repost, and the unrelated original.
    expect(screen.getAllByTestId('feed-post-body')).toHaveLength(3);

    await act(async () => {
      fireEvent.press(
        within(screen.getByTestId('feed-post-theirs')).getByTestId('feed-post-more-button'),
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText('BLOCK COLLECTOR THEIRS'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('feed-post-block-confirm-confirm'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Their own post')).not.toBeOnTheScreen();
    });
    // The repost is gone too — it was the one that survived before.
    expect(screen.queryByTestId('feed-repost-attribution')).toBeNull();
    // …and the unrelated original is untouched.
    expect(screen.getAllByTestId('feed-post-body')).toHaveLength(1);
    expect(screen.getByText('Unrelated post')).toBeTruthy();
  });
  });

  it('renders a card chip for a post anchored to a card', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '1', body: 'Card post', cardId: 'card-xyz' }),
    ]);

    renderFeed();

    await waitFor(() => {
      expect(screen.getByTestId('feed-post-card-chip')).toBeTruthy();
    });
    expect(screen.getByText('View card')).toBeTruthy();
  });
});

// The market sections default off in every build; the tests above that exercise
// them switch them on here (the "switched off" suites set '0' after this runs).
beforeEach(() => {
  process.env.EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS = '1';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS;
});
