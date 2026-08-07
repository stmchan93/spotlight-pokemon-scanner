import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { InventoryCardEntry } from '@spotlight/api-client';

import type { UserProfile } from '@/features/auth/auth-models';
import {
  fetchProfileByHandle,
  fetchProfileById,
  followUser,
  isFollowing,
  unfollowUser,
} from '@/features/profile/profile-service';
import { findOrCreateDm } from '@/features/social/dm-service';
import { fetchAuthorPosts } from '@/features/social/social-service';
import { PublicProfileScreen } from '@/features/profile/screens/public-profile-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// Shared across renders so navigation assertions can inspect it. `mock`-prefixed
// so babel-plugin-jest-hoist allows it inside the hoisted factory below.
const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

jest.mock('@/features/social/dm-service', () => ({
  findOrCreateDm: jest.fn(),
}));

jest.mock('@/features/profile/profile-service', () => ({
  fetchProfileByHandle: jest.fn(),
  fetchProfileById: jest.fn(),
  isFollowing: jest.fn(),
  followUser: jest.fn(),
  unfollowUser: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => ({
  fetchAuthorPosts: jest.fn(),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  addComment: jest.fn(async () => null),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
}));

function buildPost(overrides: { id: string } & Record<string, unknown>) {
  return {
    authorId: 'user-1',
    author: { displayName: 'Ash Ketchum', handle: 'ash', avatarUrl: null, isVerified: true },
    body: 'A post body',
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    media: [],
    ...overrides,
  };
}

// The auth-provider test bypass signs in as this synthetic user, so the viewer's
// id is fixed. A profile whose userID differs is "someone else" (Follow shows);
// a profile with this exact id is "your own" (Follow hides).
const VIEWER_ID = '00000000-0000-0000-0000-000000000001';

const profile: UserProfile = {
  userID: 'user-1',
  displayName: 'Ash Ketchum',
  avatarURL: null,
  labelerEnabled: false,
  adminEnabled: false,
  handle: 'ash',
  bio: 'Gotta collect them all.',
  location: 'Pallet Town',
  socialLink: null,
  isVerified: true,
  reputation: 56,
  followerCount: 12,
  followingCount: 34,
  postCount: 2,
};

function buildEntry(
  overrides: Partial<InventoryCardEntry> & Pick<InventoryCardEntry, 'id' | 'name'>,
): InventoryCardEntry {
  return {
    cardId: overrides.cardId ?? `card-${overrides.id}`,
    cardNumber: '#001/100',
    setName: 'Test Set',
    imageUrl: 'https://example.com/card.png',
    marketPrice: 12.5,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-05-01T00:00:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    ...overrides,
  };
}

function renderPublicProfile(
  props: Partial<React.ComponentProps<typeof PublicProfileScreen>> = {},
  repositoryOverrides: Parameters<typeof createTestSpotlightRepository>[0] = {},
) {
  const repository = createTestSpotlightRepository({
    getProfileDeckEntries: async () => [
      buildEntry({ id: 'entry-1', name: 'Pikachu' }),
      buildEntry({ id: 'entry-2', name: 'Charizard' }),
    ],
    getProfilePortfolioSummary: async () => ({
      userId: 'user-1',
      totalValue: 1234.5,
      cardCount: 2,
      currency: 'USD',
    }),
    ...repositoryOverrides,
  });

  return renderWithProviders(<PublicProfileScreen handle="ash" {...props} />, {
    spotlightRepository: repository,
  });
}

describe('PublicProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchProfileByHandle as jest.Mock).mockResolvedValue(profile);
    (fetchProfileById as jest.Mock).mockResolvedValue(null);
    (isFollowing as jest.Mock).mockResolvedValue(false);
    (followUser as jest.Mock).mockResolvedValue(true);
    (unfollowUser as jest.Mock).mockResolvedValue(true);
    (fetchAuthorPosts as jest.Mock).mockResolvedValue([]);
    (findOrCreateDm as jest.Mock).mockResolvedValue('conversation-1');
  });

  it('shows a loading state before the profile resolves', () => {
    (fetchProfileByHandle as jest.Mock).mockReturnValue(new Promise(() => {}));

    renderPublicProfile();

    expect(screen.getByTestId('public-profile-loading')).toBeTruthy();
  });

  it('renders the profile header with the fetched counts', async () => {
    renderPublicProfile();

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-header')).toBeTruthy();
    });

    expect(screen.getByText('Ash Ketchum')).toBeTruthy();
    expect(screen.getByText('@ash')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('34')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();
  });

  it('resolves by handle, and falls back to the user id when no handle matches', async () => {
    (fetchProfileByHandle as jest.Mock).mockResolvedValue(null);
    (fetchProfileById as jest.Mock).mockResolvedValue({ ...profile, handle: null });

    renderPublicProfile({ handle: 'ash', userId: 'user-1' });

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-header')).toBeTruthy();
    });

    expect(fetchProfileByHandle).toHaveBeenCalledWith('ash');
    expect(fetchProfileById).toHaveBeenCalledWith('user-1');
  });

  it('shows the visitor-visible portfolio total and card grid', async () => {
    renderPublicProfile();

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-total-value')).toBeTruthy();
    });

    expect(screen.getByTestId('public-profile-total-value')).toHaveTextContent('$1,234.50');
    expect(screen.getByTestId('public-profile-total-count')).toHaveTextContent('2 cards');
    expect(screen.getByTestId('public-profile-collection-grid-row-0')).toBeTruthy();
    expect(screen.getByText('Pikachu')).toBeTruthy();
  });

  it('does not render a portfolio chart for visitors', async () => {
    renderPublicProfile();

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-total-value')).toBeTruthy();
    });

    expect(screen.queryByTestId('portfolio-chart-card')).toBeNull();
    expect(screen.queryByTestId('portfolio-balance-header')).toBeNull();
  });

  it('gates For Sale behind a Coming soon state', async () => {
    renderPublicProfile();

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-tabs')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('public-profile-tabs-tab-forsale'));
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(screen.getByText('For Sale is coming soon.')).toBeTruthy();
  });

  describe('the Activity tab', () => {
    it('renders the collector\'s posts', async () => {
      (fetchAuthorPosts as jest.Mock).mockResolvedValue([
        buildPost({ id: 'post-1', body: 'First scan of the day!' }),
        buildPost({ id: 'post-2', body: 'Just pulled a Charizard' }),
      ]);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-tabs')).toBeTruthy();
      });

      fireEvent.press(screen.getByTestId('public-profile-tabs-tab-activity'));

      await waitFor(() => {
        expect(screen.getByText('First scan of the day!')).toBeTruthy();
      });
      expect(fetchAuthorPosts).toHaveBeenCalledWith('user-1');
      expect(screen.getByText('Just pulled a Charizard')).toBeTruthy();
    });

    it('shows a friendly empty state when there are no posts', async () => {
      (fetchAuthorPosts as jest.Mock).mockResolvedValue([]);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-tabs')).toBeTruthy();
      });

      fireEvent.press(screen.getByTestId('public-profile-tabs-tab-activity'));

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-activity-empty')).toBeTruthy();
      });
      expect(screen.getByText('No posts yet')).toBeTruthy();
      expect(screen.getByText('This collector has no posts yet.')).toBeTruthy();
    });

    it('renders a card chip on a post anchored to a card', async () => {
      (fetchAuthorPosts as jest.Mock).mockResolvedValue([
        buildPost({ id: 'post-1', body: 'Look at this one', cardId: 'card-xyz' }),
      ]);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-tabs')).toBeTruthy();
      });

      fireEvent.press(screen.getByTestId('public-profile-tabs-tab-activity'));

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-post-card-chip')).toBeTruthy();
      });
      expect(screen.getByText('View card')).toBeTruthy();
    });
  });

  it('renders a not-found state for a handle that matches nobody', async () => {
    (fetchProfileByHandle as jest.Mock).mockResolvedValue(null);

    renderPublicProfile({ handle: 'ghost' });

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-not-found')).toBeTruthy();
    });

    expect(screen.getByText('Profile not found')).toBeTruthy();
  });

  it('keeps the header and shows an error state when the collection read fails', async () => {
    renderPublicProfile({}, {
      getProfileDeckEntries: async () => {
        throw new Error('backend unreachable');
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-collection-error')).toBeTruthy();
    });

    expect(screen.getByTestId('public-profile-header')).toBeTruthy();
  });

  it('calls onOpenEntry when a card is tapped', async () => {
    const onOpenEntry = jest.fn();

    renderPublicProfile({ onOpenEntry });

    await waitFor(() => {
      expect(screen.getByTestId('public-profile-collection-grid-tile-entry-1')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('public-profile-collection-grid-tile-entry-1'));

    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'entry-1', name: 'Pikachu' }),
    );
  });

  describe('the Follow button', () => {
    it('is hidden when you are viewing your own profile', async () => {
      (fetchProfileByHandle as jest.Mock).mockResolvedValue({ ...profile, userID: VIEWER_ID });

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-header')).toBeTruthy();
      });

      expect(screen.queryByTestId('public-profile-follow-button')).toBeNull();
      // Your own profile never fires an isFollowing read.
      expect(isFollowing).not.toHaveBeenCalled();
    });

    it('shows Follow for someone else and seeds from isFollowing', async () => {
      (isFollowing as jest.Mock).mockResolvedValue(true);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent('FOLLOWING');
      });
      expect(isFollowing).toHaveBeenCalledWith('user-1');
    });

    it('optimistically flips to Following and bumps the follower count on press', async () => {
      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent(/^FOLLOW$/);
      });
      // Seeded from the profile's follower_count.
      expect(screen.getByText('12')).toBeTruthy();

      fireEvent.press(screen.getByTestId('public-profile-follow-button'));

      // Optimistic: label + count flip before the write settles.
      expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent('FOLLOWING');
      expect(screen.getByText('13')).toBeTruthy();

      await waitFor(() => expect(followUser).toHaveBeenCalledWith('user-1'));
      // Still followed after the successful write.
      expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent('FOLLOWING');
      expect(screen.getByText('13')).toBeTruthy();
    });

    it('rolls back the flip and the count when followUser fails', async () => {
      (followUser as jest.Mock).mockResolvedValue(false);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent(/^FOLLOW$/);
      });

      fireEvent.press(screen.getByTestId('public-profile-follow-button'));

      // Optimistic flip lands first...
      expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent('FOLLOWING');
      expect(screen.getByText('13')).toBeTruthy();

      // ...then the failed write rolls both back.
      await waitFor(() =>
        expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent(/^FOLLOW$/),
      );
      expect(screen.getByText('12')).toBeTruthy();
    });

    it('unfollows optimistically and rolls back when unfollowUser fails', async () => {
      (isFollowing as jest.Mock).mockResolvedValue(true);
      (unfollowUser as jest.Mock).mockResolvedValue(false);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent('FOLLOWING');
      });

      fireEvent.press(screen.getByTestId('public-profile-follow-button'));

      // Optimistic unfollow: label + count drop.
      expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent(/^FOLLOW$/);
      expect(screen.getByText('11')).toBeTruthy();

      await waitFor(() =>
        expect(screen.getByTestId('public-profile-follow-button')).toHaveTextContent('FOLLOWING'),
      );
      expect(screen.getByText('12')).toBeTruthy();
    });
  });

  describe('the Message button', () => {
    it('is hidden when you are viewing your own profile', async () => {
      (fetchProfileByHandle as jest.Mock).mockResolvedValue({ ...profile, userID: VIEWER_ID });

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-header')).toBeTruthy();
      });

      // `findOrCreateDm` refuses a self-DM, so the control would only ever fail.
      expect(screen.queryByTestId('public-profile-message-button')).toBeNull();
    });

    it('opens the thread returned by findOrCreateDm, carrying the display name', async () => {
      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-message-button')).toBeTruthy();
      });

      fireEvent.press(screen.getByTestId('public-profile-message-button'));

      await waitFor(() => expect(findOrCreateDm).toHaveBeenCalledWith('user-1'));
      // `name` is what titles the thread header — the thread screen does no
      // identity lookup of its own.
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/messages/[conversationId]',
        params: { conversationId: 'conversation-1', name: 'Ash Ketchum' },
      });
    });

    it('does not navigate when findOrCreateDm returns null', async () => {
      (findOrCreateDm as jest.Mock).mockResolvedValue(null);

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-message-button')).toBeTruthy();
      });

      fireEvent.press(screen.getByTestId('public-profile-message-button'));

      // The failure is surfaced, and `/messages/null` is never pushed.
      await waitFor(() => {
        expect(screen.getByText("Couldn't open that conversation. Please try again.")).toBeTruthy();
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('opens at most one thread when the button is double-tapped', async () => {
      let resolveDm: (value: string | null) => void = () => {};
      (findOrCreateDm as jest.Mock).mockReturnValue(
        new Promise<string | null>((resolve) => {
          resolveDm = resolve;
        }),
      );

      renderPublicProfile();

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-message-button')).toBeTruthy();
      });

      const button = screen.getByTestId('public-profile-message-button');
      fireEvent.press(button);
      fireEvent.press(button);

      expect(findOrCreateDm).toHaveBeenCalledTimes(1);

      resolveDm('conversation-1');

      await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    });
  });

  describe('paging past the first page', () => {
    const PAGE_SIZE = 200;

    function buildPage(offset: number, size: number) {
      return Array.from({ length: size }, (_unused, index) =>
        buildEntry({ id: `entry-${offset + index}`, name: `Card ${offset + index}` }),
      );
    }

    it('appends the next page when the grid reaches its end', async () => {
      const getProfileDeckEntries = jest.fn(
        async (_userID: string, query?: { limit?: number; offset?: number }) =>
          query?.offset === 0 ? buildPage(0, PAGE_SIZE) : buildPage(PAGE_SIZE, 5),
      );

      renderPublicProfile({}, { getProfileDeckEntries });

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-collection-grid-tile-entry-0')).toBeTruthy();
      });
      expect(getProfileDeckEntries).toHaveBeenCalledTimes(1);

      fireEvent(screen.getByTestId('public-profile-scroll-view'), 'endReached');

      // Assert on the fetch, not on a rendered tile: FlatList virtualizes, so the
      // 201st card is in state long before it is ever mounted.
      await waitFor(() => expect(getProfileDeckEntries).toHaveBeenCalledTimes(2));
      expect(getProfileDeckEntries).toHaveBeenNthCalledWith(
        2,
        'user-1',
        expect.objectContaining({ limit: PAGE_SIZE, offset: PAGE_SIZE }),
      );
    });

    it('does not page when the first response is short of a full page', async () => {
      const getProfileDeckEntries = jest.fn(async () => buildPage(0, 2));

      renderPublicProfile({}, { getProfileDeckEntries });

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-collection-grid-tile-entry-0')).toBeTruthy();
      });

      fireEvent(screen.getByTestId('public-profile-scroll-view'), 'endReached');

      await waitFor(() => expect(getProfileDeckEntries).toHaveBeenCalledTimes(1));
    });

    it('keeps the loaded cards and stops paging when a later page fails', async () => {
      const getProfileDeckEntries = jest.fn(
        async (_userID: string, query?: { limit?: number; offset?: number }) => {
          if (query?.offset === 0) {
            return buildPage(0, PAGE_SIZE);
          }
          throw new Error('backend down');
        },
      );

      renderPublicProfile({}, { getProfileDeckEntries });

      await waitFor(() => {
        expect(screen.getByTestId('public-profile-collection-grid-tile-entry-0')).toBeTruthy();
      });

      fireEvent(screen.getByTestId('public-profile-scroll-view'), 'endReached');

      await waitFor(() => expect(getProfileDeckEntries).toHaveBeenCalledTimes(2));
      // The first page survives the failure...
      expect(screen.getByTestId('public-profile-collection-grid-tile-entry-0')).toBeTruthy();

      // ...and paging is switched off rather than retried on every scroll.
      fireEvent(screen.getByTestId('public-profile-scroll-view'), 'endReached');
      await waitFor(() => expect(getProfileDeckEntries).toHaveBeenCalledTimes(2));
    });
  });
});
