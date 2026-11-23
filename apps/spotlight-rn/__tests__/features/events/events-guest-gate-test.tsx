/**
 * What a guest sees on Events (owner rule, 2026-11-21): the event and its map,
 * nothing more. Event info, the vendor list (scroll only), filter chips and
 * search, the floor map, and a map pick shows the vendor's name. No Feed
 * switch, claim link, save or share; vendor rows don't open; the map card has
 * no actions. Buy Tickets opens without login; the Maps address opens login.
 * Signed-in users keep everything.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Linking, Share } from 'react-native';

import { mockSpotlightEventMap, type SpotlightEventsFeed } from '@spotlight/api-client';
import type { BoothClaim, BoothPost } from '@/features/events/booth-service';
import { fetchBoothClaims, fetchBoothPosts, recordBoothEvent } from '@/features/events/booth-service';
import { resetBoothStoriesForTests } from '@/features/events/booth-stories-store';
import { resetPostEventLabelReadsForTests } from '@/features/events/hooks/use-post-event-label';
import { resetSavedEventsForTests } from '@/features/events/saved-events-store';
import { EventFeed } from '@/features/events/components/event-feed';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';
import { EventsScreen } from '@/features/events/screens/events-screen';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import {
  addComment,
  fetchEventPosts,
  likePost,
  repostPost,
  type FeedPost,
} from '@/features/social/social-service';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { makeEvent, upcomingFeatured } from './event-fixtures';

const LOGIN = '/login';

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

// A minted anonymous guest by default: an id and a token, but `isGuest`.
let mockIsGuest = true;
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({
    accessToken: mockIsGuest ? 'guest-token' : 'user-token',
    applyFollowingDelta: jest.fn(),
    currentUser: { id: mockIsGuest ? 'guest-anon' : 'user-1' },
    ensureGuestSession: jest.fn(),
    isGuest: mockIsGuest,
  }),
}));

jest.mock('@/features/events/booth-service', () => ({
  claimBooth: jest.fn(async () => 'claimed'),
  unclaimBooth: jest.fn(async () => true),
  reportBoothClaim: jest.fn(async () => true),
  recordBoothEvent: jest.fn(),
  fetchBoothClaims: jest.fn(async () => new Map()),
  fetchBoothPosts: jest.fn(async () => []),
  touchEventPresence: jest.fn(),
  fetchBrowsingNow: jest.fn(async () => null),
  suggestMyBooth: jest.fn(async () => []),
  fetchHotBooths: jest.fn(async () => []),
}));

jest.mock('@/lib/supabase', () => ({ ...jest.requireActual('@/lib/supabase'), supabase: {} }));

jest.mock('@/features/profile/profile-service', () => ({
  ...jest.requireActual('@/features/profile/profile-service'),
  isFollowing: jest.fn(async () => false),
  followUser: jest.fn(async () => true),
  unfollowUser: jest.fn(async () => true),
}));

jest.mock('@/features/social/dm-service', () => ({
  ...jest.requireActual('@/features/social/dm-service'),
  findOrCreateDm: jest.fn(async () => 'conv-1'),
}));

jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  fetchEventPosts: jest.fn(async () => []),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => ({ ok: true })),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  repostPost: jest.fn(async () => true),
  unrepostPost: jest.fn(async () => true),
}));

jest.mock('@/features/meta-feed/screens/components/open-link-out', () => ({
  openLinkOut: jest.fn(async () => undefined),
}));

jest.mock('@/features/events/components/event-map', () => {
  const { View } = require('react-native');
  return { EventMap: ({ testID }: { testID?: string }) => <View testID={testID} /> };
});

jest.mock('@/providers/app-providers', () => ({
  ...jest.requireActual('@/providers/app-providers'),
  resolveRepositoryBaseUrl: () => 'https://api.example.com',
}));

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
      getAllKeys: jest.fn(() => Promise.resolve([...store.keys()])),
      multiGet: jest.fn((keys: string[]) => Promise.resolve(keys.map((key) => [key, store.get(key) ?? null]))),
      multiSet: jest.fn(() => Promise.resolve()),
      multiRemove: jest.fn(() => Promise.resolve()),
    },
  };
});

const EVENT = makeEvent({ floorMapUrl: 'https://example.com/api/v1/events/hawaii-2026-10/map' });
const FEED: SpotlightEventsFeed = { items: [EVENT] };
const VENDOR = 'main-street-cards';
const IG_VENDOR = 'dokidoki-collectibles';

function claimedByOther(): Map<string, BoothClaim> {
  return new Map([[VENDOR, { vendorId: VENDOR, userId: 'user-2', handle: 'islandslabs', claimedAt: '2026-10-29T00:00:00Z' }]]);
}

function boothPost(id: string): BoothPost {
  return {
    id,
    authorId: 'user-2',
    author: null,
    body: 'Case is up',
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: new Date().toISOString(),
    media: [{ id: `${id}-m`, width: 900, height: 1200, blurhash: null }],
    boothVendorId: VENDOR,
  };
}

function feedPost(id: string, overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id,
    authorId: `author-${id}`,
    author: { displayName: `Collector ${id}`, handle: `c${id}`, avatarUrl: null, isVerified: false },
    body: `Post ${id}`,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: '2026-10-24T20:00:00.000Z',
    media: [],
    eventId: EVENT.id,
    boothVendorId: null,
    ...overrides,
  };
}

async function renderShow(initialVendorId: string | null = null) {
  renderWithProviders(<EventDetailScreen eventId={EVENT.id} initialVendorId={initialVendorId} onBack={jest.fn()} />, {
    spotlightRepository: createTestSpotlightRepository({
      fetchSpotlightEvents: async () => FEED,
      fetchSpotlightEventMap: async () => mockSpotlightEventMap,
    }),
  });
  fireEvent(await screen.findByTestId('event-floor-map'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 440 } },
  });
  await waitFor(() => expect(fetchBoothClaims).toHaveBeenCalled());
}

function expectLoginOnly() {
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith(LOGIN);
  mockPush.mockClear();
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsGuest = true;
  resetSavedEventsForTests();
  resetBoothStoriesForTests();
  resetPostEventLabelReadsForTests();
  await AsyncStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('guest on the Events list', () => {
  function renderList() {
    renderWithProviders(<EventsScreen />, {
      spotlightRepository: createTestSpotlightRepository({ fetchSpotlightEvents: async () => ({ items: [upcomingFeatured] }) }),
    });
  }

  it('opens a show without login', async () => {
    renderList();
    fireEvent.press(await screen.findByTestId(`event-card-${upcomingFeatured.id}`));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/events/[eventId]', params: { eventId: upcomingFeatured.id } });
    expect(mockPush).not.toHaveBeenCalledWith(LOGIN);
  });

  it('shows only the upcoming list: no drawer, search, share, Saved/Past tabs or hearts', async () => {
    renderList();
    expect(await screen.findByTestId(`event-card-${upcomingFeatured.id}`)).toBeTruthy();
    expect(screen.getByTestId('events-title').props.children).toBe('UPCOMING SPOTLIGHT EVENTS');
    for (const id of [
      `event-card-${upcomingFeatured.id}-save`,
      'events-menu',
      'events-search',
      'events-share',
      'events-actions',
      'events-tabs',
      'events-tabs-tab-saved',
      'events-tabs-tab-past',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('signed in: search, tabs, the heart and Share events all work (no drawer menu)', async () => {
    mockIsGuest = false;
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderList();
    fireEvent.press(await screen.findByTestId(`event-card-${upcomingFeatured.id}-save`));
    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('events-share'));
    expect(share).toHaveBeenCalled();
    expect(screen.queryByTestId('events-menu')).toBeNull();
    fireEvent.press(screen.getByTestId('events-search'));
    expect(screen.getByTestId('events-search-field')).toBeTruthy();
    fireEvent.press(screen.getByTestId('events-tabs-tab-past'));
    expect(screen.getByTestId('events-title').props.children).toBe('PAST SPOTLIGHT EVENTS');
    fireEvent.press(screen.getByTestId('events-tabs-tab-saved'));
    expect(screen.getByTestId('events-title').props.children).toBe('SAVED EVENTS');
    expect(mockPush).not.toHaveBeenCalledWith(LOGIN);
  });
});

describe('guest on a show page: look only', () => {
  it('sees the map with no Map | Feed switch, no claim link, no save or share', async () => {
    await renderShow();
    expect(screen.getByTestId('event-floor-map')).toBeTruthy();
    expect(screen.getByTestId('event-detail-title')).toBeTruthy();
    expect(screen.getByTestId('event-detail-pricing')).toBeTruthy();
    expect(screen.queryByTestId('event-detail-show-area')).toBeNull();
    expect(screen.queryByText('Feed')).toBeNull();
    expect(screen.queryByTestId('event-feed')).toBeNull();
    expect(screen.queryByTestId('event-vendors-find-booth')).toBeNull();
    expect(screen.queryByText('Tap here to claim your vendor booth')).toBeNull();
    expect(screen.queryByTestId('event-detail-save')).toBeNull();
    expect(screen.queryByTestId('event-detail-share')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('filters vendors by tag chip and by search', async () => {
    await renderShow();
    const before = screen.getAllByTestId(/^event-vendor-[a-z0-9-]+$/).length;
    const [chip] = screen.getAllByTestId(/^event-vendors-tag-/);
    fireEvent.press(chip);
    expect(chip.props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getAllByTestId(/^event-vendor-[a-z0-9-]+$/).length).toBeLessThanOrEqual(before);

    fireEvent.changeText(screen.getByTestId('event-vendors-search'), 'zzzz-no-such-vendor');
    expect(screen.getByTestId('event-vendors-empty')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('vendor rows are not pressable', async () => {
    await renderShow();
    const row = screen.getByTestId(`event-vendor-${VENDOR}`);
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.onClick ?? row.props.onPress).toBeUndefined();
    fireEvent.press(row);
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a vendor picked on the map shows only its name and table, no actions', async () => {
    jest.mocked(fetchBoothClaims).mockResolvedValue(claimedByOther());
    jest.mocked(fetchBoothPosts).mockResolvedValue([boothPost('p1')]);
    // The map tap and a deep link / ticker pick share the select path.
    await renderShow(VENDOR);
    expect((await screen.findByTestId('event-vendor-card-name')).props.children).toBe('Main Street Cards');
    for (const id of [
      'event-vendor-card-instagram',
      'booth-claim',
      'booth-holder',
      'booth-message',
      'booth-follow',
      'booth-report',
      'booth-strip-p1',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByText('This is my booth')).toBeNull();
    expect(screen.queryByTestId(`booth-story-${VENDOR}`)).toBeNull();
    fireEvent.press(screen.getByTestId('event-vendor-card-close'));
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();
    expect(recordBoothEvent).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a map-picked vendor with Instagram still shows no Instagram link', async () => {
    await renderShow(IG_VENDOR);
    expect(await screen.findByTestId('event-vendor-card-name')).toBeTruthy();
    expect(screen.queryByTestId('event-vendor-card-instagram')).toBeNull();
  });

  it('Buy Tickets opens without login; the Maps address opens login', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderShow();

    // Buying a ticket needs no Ekalight account (owner, 2026-11-21).
    fireEvent.press(screen.getByTestId('event-detail-buy'));
    expect(openLinkOut).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('event-detail-address'));
    expectLoginOnly();
    expect(openURL).not.toHaveBeenCalled();
  });
});

describe('signed in on a show page: unchanged', () => {
  beforeEach(() => {
    mockIsGuest = false;
  });

  it('has the Map | Feed switch, save, share and the claim link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await renderShow();
    fireEvent.press(within(screen.getByTestId('event-detail-show-area')).getByText('Feed'));
    expect(await screen.findByTestId('event-feed')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('event-detail-show-area')).getByText('Map'));

    fireEvent.press(screen.getByTestId('event-detail-save'));
    expect(screen.getByLabelText('Remove from saved events')).toBeTruthy();
    fireEvent.press(screen.getByTestId('event-detail-share'));
    expect(share).toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('event-vendors-find-booth'));
    expect(screen.getByText('Tap Claim on your booth')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalledWith(LOGIN);
  });

  it('opens a vendor from the list with its actions', async () => {
    await renderShow();
    fireEvent.press(screen.getByTestId(`event-vendor-${IG_VENDOR}`));
    expect(screen.getByTestId('event-vendor-card')).toBeTruthy();
    expect(screen.getByTestId('event-vendor-card-instagram')).toBeTruthy();
    expect(screen.getByTestId('booth-claim')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalledWith(LOGIN);
  });
});

// Guests can't reach the show feed any more; its post-card gates stay as they were.
describe('guest on a show feed (rendered directly)', () => {
  async function renderFeed() {
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.boothOnly ? [] : [feedPost('a', { intent: 'selling', boothVendorId: VENDOR })],
    );
    renderWithProviders(<EventFeed eventId={EVENT.id} testID="event-feed" />, {
      spotlightRepository: createTestSpotlightRepository({ fetchSpotlightEvents: async () => FEED }),
    });
    return screen.findByTestId('event-feed-post-a');
  }

  it('commenting opens login: no thread, no comment written', async () => {
    const card = await renderFeed();
    fireEvent.press(within(card).getByTestId('event-feed-post-comment-button'));
    expectLoginOnly();
    expect(screen.queryByTestId('event-feed-post-comments-input')).toBeNull();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('like, repost, share and the author open login and write nothing', async () => {
    const card = await renderFeed();
    await act(async () => fireEvent.press(within(card).getByTestId('event-feed-post-like-button')));
    expectLoginOnly();
    expect(likePost).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(within(card).getByTestId('event-feed-post-repost-button')));
    expectLoginOnly();
    expect(repostPost).not.toHaveBeenCalled();

    fireEvent.press(within(card).getByTestId('event-feed-post-share-button'));
    expectLoginOnly();
    expect(screen.queryByTestId('event-feed-post-share-sheet')).toBeNull();

    fireEvent.press(within(card).getByTestId('event-feed-post-author-name-button'));
    expectLoginOnly();
  });
});
