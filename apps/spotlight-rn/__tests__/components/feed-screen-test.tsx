import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { deletePost, fetchFollowingFeed, fetchGlobalFeed } from '@/features/social/social-service';
import { FeedScreen } from '@/features/social/screens/feed-screen';

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

jest.mock('@/features/social/social-service', () => ({
  deletePost: jest.fn(async () => true),
  fetchFollowingFeed: jest.fn(),
  fetchGlobalFeed: jest.fn(),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  addComment: jest.fn(async () => null),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
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

    // `-add`, not `-compose`: the feed draws the SHARED `HomeHeader` now, whose
    // `+` is the generic add affordance. The feed's own `FeedHeader` is gone —
    // it had solid IconButtons in a bar that occupied layout, where this one is
    // glass bubbles floating over the list.
    fireEvent.press(screen.getByTestId('feed-header-add'));
    expect(push).toHaveBeenCalledWith('/new-post');

    fireEvent.press(screen.getByTestId('feed-header-search'));
    expect(push).toHaveBeenCalledWith('/catalog/search');

    fireEvent.press(screen.getByTestId('feed-header-notifications'));
    expect(push).toHaveBeenCalledWith('/notifications');
  });

  // The bar is PART OF THE PAGE: it is the list's own header row, so it scrolls
  // away with the posts, and it carries the rule that marks the top of the page.
  // Neither is visible to an ordinary render assertion, and the bar has already
  // been wrong twice — solid buttons stacked above the list, then floating
  // chrome with a fading pill.
  it('makes the top bar a scrolling list row, not chrome pinned over the list', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    // Not a sibling of the list any more — if it were, it would stay put.
    const rootChildTestIDs = screen
      .getByTestId('feed')
      .props.children.map((child: { props?: { testID?: string } }) => child?.props?.testID)
      .filter(Boolean);
    expect(rootChildTestIDs).not.toContain('feed-header');

    // ...it lives inside the scroller, and it is not absolutely positioned.
    const bar = screen.getByTestId('feed-header');
    expect(StyleSheet.flatten(bar.props.style).position).toBeUndefined();

    // Figma 3505:14520 — the rule under the bar.
    expect(screen.getByTestId('feed-header-rule')).toBeTruthy();
  });

  it('opens the app drawer from the header menu', async () => {
    renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(screen.getByText('Feed post')).toBeTruthy());

    fireEvent.press(screen.getByTestId('feed-header-menu'));

    // The drawer is context state, not navigation.
    expect(mockOpenDrawer).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
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

    it('only offers the ⋯ menu on the post you wrote', async () => {
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      // One ⋯ for two posts: yours.
      expect(screen.getAllByTestId('feed-post-more-button')).toHaveLength(1);
    });

    it('asks for confirmation before deleting anything', async () => {
      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-post-more-button'));
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
        fireEvent.press(screen.getByTestId('feed-post-more-button'));
      });
      await screen.findByTestId('feed-delete-confirm');
      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-delete-confirm-confirm'));
      });

      await waitFor(() => expect(screen.queryByText('My own post')).not.toBeOnTheScreen());
      expect(deletePost).toHaveBeenCalledWith('mine');
      expect(screen.getByText('Someone else post')).toBeTruthy();
    });

    it('puts the post back and tells the user when the delete fails', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      (deletePost as jest.Mock).mockResolvedValue(false);

      renderWithProviders(<FeedScreen />);
      await waitFor(() => expect(screen.getByText('My own post')).toBeTruthy());

      await act(async () => {
        fireEvent.press(screen.getByTestId('feed-post-more-button'));
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
});
