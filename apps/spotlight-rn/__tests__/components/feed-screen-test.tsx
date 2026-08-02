import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { fetchFollowingFeed, fetchGlobalFeed } from '@/features/social/social-service';
import { FeedScreen } from '@/features/social/screens/feed-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useFocusEffect: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => ({
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
    (fetchFollowingFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '1', body: 'Following post' }),
    ]);
    (fetchGlobalFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '2', body: 'Global post' }),
    ]);
  });

  it('renders the following feed on first load', async () => {
    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByText('Following post')).toBeTruthy();
    });
    expect(fetchFollowingFeed).toHaveBeenCalled();
    expect(fetchGlobalFeed).not.toHaveBeenCalled();
  });

  it('switches to the global feed when the Global segment is pressed', async () => {
    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByText('Following post')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('feed-segment-global'));

    await waitFor(() => {
      expect(screen.getByText('Global post')).toBeTruthy();
    });
    expect(fetchGlobalFeed).toHaveBeenCalled();
  });

  it('shows an empty state when the following feed is empty', async () => {
    (fetchFollowingFeed as jest.Mock).mockResolvedValue([]);

    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('feed-empty')).toBeTruthy();
    });
    expect(screen.getByText('Follow collectors to see their posts here.')).toBeTruthy();
  });

  it('shows the composer entry row even when there are no posts, and opens the composer', async () => {
    (fetchFollowingFeed as jest.Mock).mockResolvedValue([]);

    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('feed-empty')).toBeTruthy();
    });
    expect(screen.getByText('What’s on your mind?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('feed-composer-row'));
    expect(push).toHaveBeenCalledWith('/new-post');
  });

  it('renders a card chip for a post anchored to a card', async () => {
    (fetchFollowingFeed as jest.Mock).mockResolvedValue([
      buildPost({ id: '1', body: 'Card post', cardId: 'card-xyz' }),
    ]);

    renderWithProviders(<FeedScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('feed-post-card-chip')).toBeTruthy();
    });
    expect(screen.getByText('View card')).toBeTruthy();
  });
});
