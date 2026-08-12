import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, Animated, FlatList, Platform, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import {
  deletePost,
  fetchFollowingFeed,
  fetchGlobalFeed,
  fetchGlobalFeedItems,
} from '@/features/social/social-service';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { getFeedRefreshVersion, signalFeedNeedsRefresh } from '@/features/social/screens/new-post-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useFocusEffect: jest.fn(),
}));

// The header's hamburger opens the shared app drawer. Keep the real provider
// (test-utils mounts it) and only swap the hook so the call is observable.
const mockOpenDrawer = jest.fn();
jest.mock('@/providers/app-drawer-provider', () => {
  const actual = jest.requireActual('@/providers/app-drawer-provider');
  return {
    ...actual,
    useAppDrawer: () => ({ ...actual.useAppDrawer(), openDrawer: mockOpenDrawer }),
  };
});

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

describe('FeedScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '1', body: 'Feed post' }),
    ]);
  });

  // Home is ONE feed: every visible post, newest first. The screen carried a
  // Following / Global switch until it became the Home tab; this asserts the
  // remaining read is the global one and that the follow graph no longer gates
  // what you see, which is the whole behavioural change.
  it('reads the global feed, and only the global feed, on first load', async () => {
    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByText('Feed post')).toBeTruthy();
    });
    expect(fetchGlobalFeed).toHaveBeenCalled();
    expect(fetchFollowingFeed).not.toHaveBeenCalled();
    // No switch to press any more.
    expect(screen.queryByTestId('feed-segment-tab-global')).toBeNull();
    expect(screen.queryByTestId('feed-segment-tab-following')).toBeNull();
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

      renderWithProviders(<FeedScreen />);

      await waitFor(() => {
        expect(screen.getByTestId('feed-repost-attribution')).toBeTruthy();
      });
      expect(screen.getByText('Misty reposted')).toBeTruthy();
    });

    // The repost and the original are DIFFERENT rows for the SAME post — keyed
    // on the post id alone, React would drop one as a duplicate key.
    it('renders the repost and the original as two separate rows', async () => {
      mockFeedWithRepost();

      renderWithProviders(<FeedScreen />);

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

    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // ABOVE the feed: a `ListHeaderComponent`, so it precedes every post row in
    // tree order — asserted across prompt and bodies together, in one query.
    const rows = screen.getAllByTestId(/^feed-(compose-prompt|post-body)$/);
    expect(rows).toHaveLength(3);
    expect(rows[0].props.testID).toBe('feed-compose-prompt');

    expect(screen.getByText('What’s on your mind?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('feed-compose-prompt'));
    expect(push).toHaveBeenCalledWith('/new-post');
  });

  /*
    On Android, cell 0 paints over the header's fractional bottom edge, so
    EVERY line drawn from the header's side — sibling hairline, border, even a
    zIndex'd border — got shaved to a lighter sliver once posts loaded. The
    rule therefore has two owners: the header's border while the list is
    empty, and the first cell itself once posts exist. This pins both halves.
  */
  it('hands the compose rule to the first cell once posts load', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // The header's own border is OFF — a line here would be shaved on Android
    // (and double-ruled everywhere else).
    const section = screen.getByTestId('feed-compose-divider');
    const style = StyleSheet.flatten(section.props.style);
    expect(style.borderBottomWidth).toBe(0);
    expect(style.width).toBe('100%');
    expect(within(section).getByTestId('feed-compose-prompt')).toBeTruthy();

    // The first cell draws the rule itself, in the same View form as the
    // card's bottom divider, so the two lines rasterize identically.
    const rule = screen.getByTestId('feed-first-cell-rule');
    const ruleStyle = StyleSheet.flatten(rule.props.style);
    expect(ruleStyle.height).toBeGreaterThan(0);
    expect(ruleStyle.backgroundColor).toBeTruthy();
  });

  it('keeps the compose rule as a header border while the feed is empty', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([]);
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByTestId('feed-compose-divider')).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('feed-first-cell-rule')).not.toBeOnTheScreen());

    const style = StyleSheet.flatten(screen.getByTestId('feed-compose-divider').props.style);
    expect(style.borderBottomWidth).toBeGreaterThan(0);
    expect(style.borderBottomColor).toBeTruthy();
  });

  it('shows an empty state when there are no posts', async () => {
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([]);

    renderWithProviders(<FeedScreen />);

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

    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('feed-empty')).toBeTruthy();
    });

    // Composing is NOT a header action any more — the bar's `+` was invisible
    // to users and the compose prompt row replaced it — but it must survive an
    // empty feed just the same. It does, because a `ListHeaderComponent`
    // renders above `ListEmptyComponent`, not instead of it.
    fireEvent.press(screen.getByTestId('feed-compose-prompt'));
    expect(push).toHaveBeenCalledWith('/new-post');

    fireEvent.press(screen.getByTestId('feed-header-search'));
    expect(push).toHaveBeenCalledWith('/catalog/search');

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

  // The bar FLOATS and its bubbles stay put; only the pill gets out of the way.
  // This has been wrong in every direction — solid buttons stacked above the
  // list, then one bar that scrolled away whole, then the inverse where the
  // bubbles left and the pill stayed — so the shape is pinned here.
  it('keeps the bubbles pinned over the list and disarms the pill once it fades', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // Floating chrome: absolutely positioned, painted over the list.
    const bar = screen.getByTestId('feed-header');
    expect(StyleSheet.flatten(bar.props.style).position).toBe('absolute');

    // Both halves are live at rest. The FADE itself is a native-driven opacity
    // and the disarm rides on a scroll listener that this environment does not
    // dispatch through the animated list, so it is deliberately not asserted
    // here rather than asserted falsely — `portfolio-screen-test` covers the
    // same pill/bubble contract on the pager, which does dispatch.
    push.mockClear();
    fireEvent.press(screen.getByTestId('feed-header-search'));
    expect(push).toHaveBeenLastCalledWith('/catalog/search');

    fireEvent.press(screen.getByTestId('feed-header-notifications'));
    expect(push).toHaveBeenLastCalledWith('/notifications');
  });

  /*
    ═══════════════════════════════════════════════════════════════════════════
    THE PILL IS VISIBLE THE MOMENT THE APP OPENS.
    ═══════════════════════════════════════════════════════════════════════════
    Reported as "the search cards is disappeared when I first open the app", on
    iOS only.

    This list runs `contentInsetAdjustmentBehavior="automatic"` and so RESTS at
    `-insets.top`, which is what it hands the bar as `scrollRestOffset`. The bar
    fades the pill across `[rest, rest + 56]` — `[-59, -3]` on this harness's
    59pt inset. Seeding the scroll value at 0 therefore started it PAST the end
    of that range, so the pill mounted at opacity 0 and only snapped in once the
    first scroll event delivered the real offset.

    Android rests at 0 and was always fine, which is exactly why this survived:
    the wrong seed agrees with the right answer on one platform.

    Read off the HOST node, whose style carries the interpolation already
    resolved to numbers — the same technique `home-header-test` uses, and the
    only way the fade's origin is observable off-device.
  */
  it('shows the search pill at rest, before anything has scrolled', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    const motion = StyleSheet.flatten(
      screen.getByTestId('feed-header-search-motion').props.style,
    ) as { opacity: number };

    expect(motion.opacity).toBe(1);
  });

  /*
    NO RULE AT ALL — deliberately, and this test is inverted rather than deleted
    so the removal is visible to whoever comes looking for the hairline.

    The feed used to render one as its first list row (`HomeHeaderRule`), on the
    reading that the hairline belonged to the page rather than to the floating
    bar. The live frame (Figma "Home" 3523:15499) draws no line under the
    toolbar: the bar is floating glass that is meant to hover, and the only
    hairlines on Home are the ones each post card closes with. The bar's own 8pt
    bottom padding plus a card's 16pt top inset is the whole gap.
  */
  it('draws no hairline under the bar — not in the list, not in the bar', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    expect(screen.queryByTestId('feed-header-rule')).toBeNull();
    expect(within(screen.getByTestId('feed-header')).queryByTestId('feed-header-rule')).toBeNull();
    expect(within(screen.getByTestId('feed-list')).queryByTestId('feed-header-rule')).toBeNull();
  });

  it('opens the app drawer from the header menu', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    fireEvent.press(screen.getByTestId('feed-header-menu'));

    // The drawer is context state, not navigation.
    expect(mockOpenDrawer).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  // This gesture has been dropped TWICE by rewrites of this screen, so it is
  // pinned here. The drawer is the only route to Insights, Messages and Account,
  // and Home is the landing screen — losing the drag leaves it working on You
  // and nowhere else, which reads as broken rather than absent.
  // `drawer-edge-swipe-test` drives the recogniser's own thresholds; all this
  // asserts is that the feed is still wrapped in one.
  it('also opens the drawer by dragging in from the left edge, not only from the button', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    expect(screen.getByTestId('drawer-edge-swipe')).toBeTruthy();
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
      renderWithProviders(<FeedScreen />);
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
      renderWithProviders(<FeedScreen />);
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
      renderWithProviders(<FeedScreen />);
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
      renderWithProviders(<FeedScreen />);
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
      expect(screen.getByText('Report post')).toBeTruthy();
      expect(screen.getByText('Block Collector theirs')).toBeTruthy();
      expect(screen.getByTestId('feed-post-options-cancel')).toBeTruthy();
      alertSpy.mockRestore();
    });

    it('asks for confirmation before deleting anything', async () => {
      renderWithProviders(<FeedScreen />);
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
      renderWithProviders(<FeedScreen />);
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

      renderWithProviders(<FeedScreen />);
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

      renderWithProviders(<FeedScreen />);
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

      renderWithProviders(<FeedScreen />);
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

    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Their own post')).toBeTruthy());
    // Their post, their repost, and the unrelated original.
    expect(screen.getAllByTestId('feed-post-body')).toHaveLength(3);

    await act(async () => {
      fireEvent.press(
        within(screen.getByTestId('feed-post-theirs')).getByTestId('feed-post-more-button'),
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Block Collector theirs'));
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

    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('feed-post-card-chip')).toBeTruthy();
    });
    expect(screen.getByText('View card')).toBeTruthy();
  });

  /*
    "Back to top" (Figma 3725:59137). Collection, Wishlist and Insights have all
    carried the FAB for a while; Home never got one.

    Three things make the feed's copy of it different from every other caller,
    and all three fail SILENTLY, so all three are pinned here.

    1. NATIVE DRIVER. The list's `onScroll` is an `Animated.event` with
       `useNativeDriver: true` — it is what animates the floating bar. But
       `useScrollToTop(ref, onScroll)` wraps whatever it is handed in a plain JS
       `useCallback`, so passing that event in and using the result as `onScroll`
       is precisely the arrow-function wrap the event's own comment warns about.
       The hook is therefore given NO handler, and its `handleScroll` is invoked
       from inside the event's `listener`, beside `setIsSearchPillHidden`.

    2. NEGATIVE REST OFFSET. `contentInsetAdjustmentBehavior="automatic"` means
       UIKit insets this list, so on iOS it rests at `-insets.top`, not at 0 —
       the Collection pages' `pageTopOffset` again. That offset has to be used
       BOTH for the scroll target and for the travel measurement that decides
       when the button shows. Android takes the explicit-padding branch and
       rests at 0.

    3. CLAMPING. RN clamps a negative `scrollTo`/`scrollToOffset` target back to
       0 unless `scrollToOverflowEnabled` is set, so without that prop point 2 is
       inert and "back to top" lands a status bar short.
  */
  describe('the back-to-top button', () => {
    /** The top inset `renderWithProviders` mounts. The list rests at `-59`. */
    const TOP_INSET = 59;
    /** The viewport `handleLayout` is told about, i.e. the reveal threshold. */
    const VIEWPORT = 800;

    /**
     * Just past one viewport of TRAVEL from a list resting at -59
     * (760 + 59 = 819 > 800), but short of it by the raw-offset arithmetic
     * (760 < 800). The only band where the inset handling is observable.
     */
    const PAST_ONE_VIEWPORT = 760;

    function feedList() {
      return screen.getByTestId('feed-list');
    }

    /**
     * The button is always mounted — `ScrollToTopButton` fades and disarms
     * rather than unmounting — so "visible" is read off the wrapper's
     * `pointerEvents`, which is also what makes it untappable while hidden.
     */
    function fabPointerEvents() {
      // The `pointerEvents` lives on the primitive's animated wrapper, a few
      // composite layers above the pressable that carries the testID.
      let node: ReturnType<typeof screen.getByTestId> | null =
        screen.getByTestId('feed-scroll-to-top');
      while (node && node.props?.pointerEvents === undefined) {
        node = node.parent;
      }
      return node?.props?.pointerEvents;
    }

    async function measureViewport() {
      await act(async () => {
        fireEvent(feedList(), 'layout', {
          nativeEvent: { layout: { height: VIEWPORT, width: 393, x: 0, y: 0 } },
        });
      });
    }

    async function scrollFeed(y: number) {
      await act(async () => {
        fireEvent.scroll(feedList(), {
          nativeEvent: {
            contentOffset: { y },
            contentSize: { height: 4000, width: 393 },
            layoutMeasurement: { height: VIEWPORT, width: 393 },
          },
        });
      });
    }

    it('keeps the scroll handler natively driven', async () => {
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

      // `Animated.event` returns the AnimatedEvent OBJECT when it is native and
      // a plain handler function when it is not, so this distinguishes the two.
      // Composing the FAB by passing this handler through `useScrollToTop` would
      // turn it into a function here and move the bar's motion onto the bridge.
      const onScroll = screen.UNSAFE_getByType(Animated.FlatList as never).props.onScroll;
      expect(typeof onScroll).toBe('object');
      expect(onScroll.__isNative).toBe(true);
    });

    it('does not appear while the feed is at rest', async () => {
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      await measureViewport();

      expect(fabPointerEvents()).toBe('none');

      // A short scroll is still not a viewport of travel.
      await scrollFeed(120 - TOP_INSET);
      expect(fabPointerEvents()).toBe('none');
    });

    it('appears once the feed has been scrolled past one viewport', async () => {
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      await measureViewport();

      await scrollFeed(PAST_ONE_VIEWPORT);
      expect(fabPointerEvents()).toBe('auto');
    });

    it('scrolls to the list’s real top, which on iOS is not 0', async () => {
      const scrollToOffset = jest
        .spyOn(FlatList.prototype, 'scrollToOffset')
        .mockImplementation(() => {});

      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      await measureViewport();
      await scrollFeed(PAST_ONE_VIEWPORT);

      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-scroll-to-top'));
      });

      // `-insets.top`, not 0: the list is inset by UIKit and RESTS there.
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: -TOP_INSET, animated: true });
      scrollToOffset.mockRestore();
    });

    // The prop that stops RN clamping that negative target back to 0. It lives
    // on the list, not on the FAB, so it is asserted separately — without it the
    // offset above is computed correctly and then thrown away.
    it('lets the list accept that negative target', async () => {
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

      expect(feedList().props.scrollToOverflowEnabled).toBe(true);
    });

    it('scrolls to 0 on Android, where the list is not inset', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      const scrollToOffset = jest
        .spyOn(FlatList.prototype, 'scrollToOffset')
        .mockImplementation(() => {});

      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());
      await measureViewport();
      // Android reserves the bar with `paddingTop` instead, so it rests at 0 and
      // the same 760 is genuinely short of a viewport — the button stays hidden.
      await scrollFeed(PAST_ONE_VIEWPORT);
      expect(fabPointerEvents()).toBe('none');

      await scrollFeed(VIEWPORT + 1);
      expect(fabPointerEvents()).toBe('auto');
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-scroll-to-top'));
      });
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
      scrollToOffset.mockRestore();
    });

    // Visibility is scroll TRAVEL only, so a feed with nothing in it can never
    // reveal the button — no extra empty-state guard is needed, and the other
    // three screens carrying this FAB rely on the same property.
    it('never appears over an empty feed', async () => {
      (fetchGlobalFeed as jest.Mock).mockResolvedValue([]);
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByTestId('feed-empty')).toBeTruthy());
      await measureViewport();

      expect(fabPointerEvents()).toBe('none');
      // Even a bounce: an empty list can only overscroll ABOVE its own top,
      // which is negative travel.
      await scrollFeed(-TOP_INSET - 40);
      expect(fabPointerEvents()).toBe('none');
    });
  });
});
