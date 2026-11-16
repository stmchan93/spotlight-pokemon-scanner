import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import type { SpotlightEventsFeed } from '@spotlight/api-client';
import { eventLocalDate } from '@/features/events/hooks/use-active-show';
import { resetPostEventLabelReadsForTests } from '@/features/events/hooks/use-post-event-label';
import { resetSavedEventsForTests } from '@/features/events/saved-events-store';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';
import { fetchEventPosts, type FeedPost } from '@/features/social/social-service';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { makeEvent, upcomingFeatured } from './event-fixtures';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('expo-router'),
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), navigate: jest.fn() }),
  };
});

jest.mock('@/features/events/components/event-map', () => {
  const { View } = require('react-native');
  return { EventMap: ({ testID }: { testID?: string }) => <View testID={testID} /> };
});

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      removeItem: jest.fn(() => Promise.resolve()),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  fetchEventPosts: jest.fn(async () => []),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
}));

function post(id: string, overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id,
    authorId: `author-${id}`,
    author: { displayName: `Collector ${id}`, handle: `c${id}`, avatarUrl: null, isVerified: false },
    body: `Post ${id}`,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: `2026-10-24T2${id.length}:00:00.000Z`,
    media: [],
    eventId: 'hawaii-2026-10',
    boothVendorId: null,
    ...overrides,
  };
}

// A show on today, so tagging it is open.
const today = eventLocalDate('UTC', new Date());
const liveShow = makeEvent({ endDate: today, startDate: today, timezone: 'UTC' });

function renderShow(event = upcomingFeatured) {
  const feed: SpotlightEventsFeed = { items: [event] };
  renderWithProviders(<EventDetailScreen eventId={event.id} onBack={jest.fn()} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchSpotlightEvents: async () => feed }),
  });
}

describe('show page Map | Feed', () => {
  beforeEach(() => {
    mockPush.mockClear();
    jest.mocked(fetchEventPosts).mockReset().mockResolvedValue([]);
    resetSavedEventsForTests();
    resetPostEventLabelReadsForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens on the map and switches to the show feed', async () => {
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.boothOnly
        ? []
        : [post('attendee'), post('booth', { boothVendorId: 'main-street-cards' })],
    );
    renderShow();

    const toggle = await screen.findByTestId('event-detail-show-area');
    expect(await screen.findByTestId('event-vendors')).toBeTruthy();
    expect(screen.queryByTestId('event-feed')).toBeNull();

    fireEvent.press(within(toggle).getByText('Feed'));

    expect(await screen.findByTestId('event-feed-post-attendee')).toBeTruthy();
    expect(screen.queryByTestId('event-vendors')).toBeNull();
    expect(fetchEventPosts).toHaveBeenCalledWith('hawaii-2026-10', 20);
    // Booth posts name the vendor and table; attendee posts carry no badge here.
    expect(await screen.findByText('📍 Main Street Cards · Table C14')).toBeTruthy();
    expect(within(screen.getByTestId('event-feed-post-attendee')).queryByTestId('event-feed-post-event-badge')).toBeNull();
  });

  it('pages in more posts when the page scrolls to the end', async () => {
    const page = Array.from({ length: 20 }, (_, index) =>
      post(`p${index}`, { createdAt: new Date(Date.UTC(2026, 9, 24, 12, 59 - index)).toISOString() }),
    );
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.before ? [post('older', { createdAt: '2026-10-24T00:00:00.000Z' })] : page,
    );
    renderShow();
    fireEvent.press(within(await screen.findByTestId('event-detail-show-area')).getByText('Feed'));
    await screen.findByTestId('event-feed-post-p19');

    fireEvent.scroll(screen.getByTestId('event-detail-scroll'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 4000 },
        contentSize: { height: 4500, width: 393 },
        layoutMeasurement: { height: 800, width: 393 },
      },
    });

    expect(await screen.findByTestId('event-feed-post-older')).toBeTruthy();
    expect(fetchEventPosts).toHaveBeenCalledWith('hawaii-2026-10', 20, { before: page[19]?.createdAt });
  });

  it('labels typed posts and filters the feed by type server-side', async () => {
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.boothOnly
        ? []
        : options?.intent === 'selling'
          ? [post('sale', { intent: 'selling', boothVendorId: 'main-street-cards' })]
          : [post('wtb', { intent: 'looking_for' }), post('plain')],
    );
    renderShow();
    fireEvent.press(within(await screen.findByTestId('event-detail-show-area')).getByText('Feed'));

    const wtb = await screen.findByTestId('event-feed-post-wtb');
    expect(within(wtb).getByText('LOOKING FOR')).toBeTruthy();
    expect(within(screen.getByTestId('event-feed-post-plain')).queryByTestId('event-feed-post-intent')).toBeNull();
    // Chips: ALL · LOOKING FOR · SELLING · BUYING, ALL selected.
    const chips = screen.getByTestId('event-feed-intent-chips');
    expect(within(chips).getByText('ALL')).toBeTruthy();
    expect(within(chips).getByText('BUYING')).toBeTruthy();
    expect(screen.getByTestId('event-feed-intent-all').props.accessibilityState).toEqual({ selected: true });

    fireEvent.press(screen.getByTestId('event-feed-intent-selling'));
    expect(await screen.findByTestId('event-feed-post-sale')).toBeTruthy();
    expect(screen.queryByTestId('event-feed-post-wtb')).toBeNull();
    expect(fetchEventPosts).toHaveBeenCalledWith('hawaii-2026-10', 20, { intent: 'selling' });

    // Back to ALL drops the filter.
    fireEvent.press(screen.getByTestId('event-feed-intent-all'));
    expect(await screen.findByTestId('event-feed-post-wtb')).toBeTruthy();
  });

  it('says which type is empty when a filter finds nothing', async () => {
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.intent ? [] : [post('plain')],
    );
    renderShow();
    fireEvent.press(within(await screen.findByTestId('event-detail-show-area')).getByText('Feed'));
    await screen.findByTestId('event-feed-post-plain');

    fireEvent.press(screen.getByTestId('event-feed-intent-buying'));
    expect(await screen.findByText('No buying posts yet')).toBeTruthy();
  });

  it('"Find on map" on a Selling booth post selects that booth on the map', async () => {
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.boothOnly
        ? []
        : [
          post('sale', { intent: 'selling', boothVendorId: 'main-street-cards' }),
          post('wtb', { intent: 'looking_for' }),
        ],
    );
    renderShow();
    fireEvent.press(within(await screen.findByTestId('event-detail-show-area')).getByText('Feed'));
    const sale = await screen.findByTestId('event-feed-post-sale');
    // Attendee "Looking for" posts have no booth to find.
    expect(within(screen.getByTestId('event-feed-post-wtb')).queryByTestId('event-feed-post-find-on-map')).toBeNull();

    fireEvent.press(within(sale).getByTestId('event-feed-post-find-on-map'));

    expect(await screen.findByTestId('event-vendor-card')).toBeTruthy();
    expect(screen.getByTestId('event-vendor-card-name')).toBeTruthy();
    expect(within(screen.getByTestId('event-vendor-card')).getByText(/Main Street Cards/i)).toBeTruthy();
  });

  it('offers + Post while the show is on, opening the composer tagged to it', async () => {
    renderShow(liveShow);
    fireEvent.press(within(await screen.findByTestId('event-detail-show-area')).getByText('Feed'));

    fireEvent.press(await screen.findByTestId('event-feed-compose'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/new-post', params: { eventId: liveShow.id } });
  });

  it('is read-only outside the show window', async () => {
    renderShow();
    fireEvent.press(within(await screen.findByTestId('event-detail-show-area')).getByText('Feed'));
    expect(await screen.findByTestId('event-feed-empty')).toBeTruthy();
    expect(screen.queryByTestId('event-feed-compose')).toBeNull();
  });

  it('shows just the feed for a show without a floor map', async () => {
    renderShow(makeEvent({ floorMapUrl: null }));
    expect(await screen.findByTestId('event-feed')).toBeTruthy();
    expect(screen.queryByTestId('event-detail-show-area')).toBeNull();
    await waitFor(() => expect(fetchEventPosts).toHaveBeenCalled());
  });
});
