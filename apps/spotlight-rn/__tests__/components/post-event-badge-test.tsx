import { fireEvent, screen } from '@testing-library/react-native';

import { formatPostEventBadge } from '@/features/social/components/post-event-badge';
import { PostCard } from '@/features/social/components/post-card';
import { resetPostEventLabelReadsForTests } from '@/features/events/hooks/use-post-event-label';
import type { FeedPost } from '@/features/social/social-service';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, navigate: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/features/social/social-service', () => ({
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  repostPost: jest.fn(async () => true),
  unrepostPost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  blockUser: jest.fn(async () => true),
  reportContent: jest.fn(async () => true),
}));

const base: FeedPost = {
  id: 'post-1',
  authorId: 'author-1',
  author: { displayName: 'Ash', handle: 'ash', avatarUrl: null, isVerified: false },
  body: 'Slabs at the show',
  cardId: null,
  likeCount: 0,
  commentCount: 0,
  repostCount: 0,
  createdAt: '2026-10-24T20:00:00.000Z',
  media: [],
};

describe('PostCard show badge', () => {
  beforeEach(() => {
    mockPush.mockClear();
    resetPostEventLabelReadsForTests();
  });

  it('draws nothing on an untagged post', () => {
    renderWithProviders(<PostCard post={base} />);
    expect(screen.queryByTestId('post-card-event-badge')).toBeNull();
  });

  it('names the show from the shared events cache and opens it', async () => {
    const fetchSpotlightEvents = jest.fn();
    renderWithProviders(<PostCard post={{ ...base, eventId: 'hawaii-2026-10', boothVendorId: null }} />, {
      spotlightRepository: createTestSpotlightRepository({
        fetchSpotlightEvents: (...args) => {
          fetchSpotlightEvents(...args);
          return createTestSpotlightRepository().fetchSpotlightEvents();
        },
      }),
    });

    expect(await screen.findByText('📍 Spotlight Hawaii')).toBeTruthy();
    fireEvent.press(screen.getByTestId('post-card-event-badge'));
    expect(mockPush).toHaveBeenCalledWith('/events/hawaii-2026-10');
    expect(fetchSpotlightEvents).toHaveBeenCalledTimes(1);
  });

  it('adds the table on a booth post and opens the show with the vendor selected', async () => {
    renderWithProviders(
      <PostCard post={{ ...base, eventId: 'hawaii-2026-10', boothVendorId: 'main-street-cards' }} />,
    );

    expect(await screen.findByText('📍 Spotlight Hawaii · Table C14')).toBeTruthy();
    fireEvent.press(screen.getByTestId('post-card-event-badge'));
    expect(mockPush).toHaveBeenCalledWith('/events/hawaii-2026-10?vendor=main-street-cards');
  });

  it("names the vendor instead of the show on the show's own feed", async () => {
    renderWithProviders(
      <PostCard
        eventBadgeMode="booth"
        post={{ ...base, eventId: 'hawaii-2026-10', boothVendorId: 'main-street-cards' }}
      />,
    );
    expect(await screen.findByText('📍 Main Street Cards · Table C14')).toBeTruthy();
  });

  it('reads the events list once for a whole feed of tagged posts', async () => {
    const fetchSpotlightEvents = jest.fn(() => createTestSpotlightRepository().fetchSpotlightEvents());
    renderWithProviders(
      <>
        {['a', 'b', 'c'].map((id) => (
          <PostCard key={id} post={{ ...base, id, eventId: 'hawaii-2026-10', boothVendorId: null }} testID={`card-${id}`} />
        ))}
      </>,
      { spotlightRepository: createTestSpotlightRepository({ fetchSpotlightEvents }) },
    );
    expect(await screen.findAllByText('📍 Spotlight Hawaii')).toHaveLength(3);
    expect(fetchSpotlightEvents).toHaveBeenCalledTimes(1);
  });
});

describe('formatPostEventBadge', () => {
  it('falls back to a generic label until the show is known', () => {
    expect(formatPostEventBadge('show', { showTitle: null, vendorName: null, table: null })).toBe('📍 Card show');
    expect(formatPostEventBadge('booth', { showTitle: 'X', vendorName: null, table: null })).toBeNull();
  });
});
