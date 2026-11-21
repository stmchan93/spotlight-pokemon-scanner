/**
 * What a guest may do on Events (owner rule, 2026-11-21): view the floor map,
 * filter the vendors, tap a vendor on the map to see who it is, and open a
 * vendor in the list. Everything else opens the login page and writes nothing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Linking, Share } from 'react-native';

import { mockSpotlightEventMap, type SpotlightEventsFeed } from '@spotlight/api-client';
import type { BoothClaim, BoothPost } from '@/features/events/booth-service';
import {
  claimBooth,
  fetchBoothClaims,
  fetchBoothPosts,
  recordBoothEvent,
  reportBoothClaim,
} from '@/features/events/booth-service';
import { resetBoothStoriesForTests } from '@/features/events/booth-stories-store';
import { resetPostEventLabelReadsForTests } from '@/features/events/hooks/use-post-event-label';
import { resetSavedEventsForTests } from '@/features/events/saved-events-store';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';
import { EventsScreen } from '@/features/events/screens/events-screen';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { followUser } from '@/features/profile/profile-service';
import { findOrCreateDm } from '@/features/social/dm-service';
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

// A minted anonymous guest: an id and a token, but `isGuest`.
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({
    accessToken: 'guest-token',
    applyFollowingDelta: jest.fn(),
    currentUser: { id: 'guest-anon' },
    ensureGuestSession: jest.fn(),
    isGuest: true,
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

  it('saving (heart) and sharing open login instead', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderList();
    fireEvent.press(await screen.findByTestId(`event-card-${upcomingFeatured.id}-save`));
    expectLoginOnly();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('events-share'));
    expectLoginOnly();
    expect(share).not.toHaveBeenCalled();
  });
});

describe('guest on a show page: the four allowed actions', () => {
  it('views the map and switches Map | Feed', async () => {
    await renderShow();
    expect(screen.getByTestId('event-floor-map')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('event-detail-show-area')).getByText('Feed'));
    expect(await screen.findByTestId('event-feed')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('event-detail-show-area')).getByText('Map'));
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

  it('a vendor picked on the map shows who it is', async () => {
    // The map tap and a deep link / ticker pick share the select path.
    await renderShow(VENDOR);
    expect((await screen.findByTestId('event-vendor-card-name')).props.children).toBe('Main Street Cards');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens a vendor from the list', async () => {
    await renderShow();
    fireEvent.press(screen.getByTestId(`event-vendor-${VENDOR}`));
    expect(screen.getByTestId('event-vendor-card-name').props.children).toBe('Main Street Cards');
    fireEvent.press(screen.getByTestId('event-vendor-card-close'));
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('guest on a show page: everything else opens login', () => {
  it('save, share and the Maps address (Buy Tickets stays open)', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderShow();

    fireEvent.press(screen.getByTestId('event-detail-save'));
    expectLoginOnly();
    expect(screen.getByLabelText('Save event')).toBeTruthy();

    fireEvent.press(screen.getByTestId('event-detail-share'));
    expectLoginOnly();
    expect(share).not.toHaveBeenCalled();

    // Buying a ticket needs no Ekalight account (owner, 2026-11-21).
    fireEvent.press(screen.getByTestId('event-detail-buy'));
    expect(openLinkOut).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('event-detail-address'));
    expectLoginOnly();
    expect(openURL).not.toHaveBeenCalled();
  });

  it('Instagram, claim mode and claiming a booth', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderShow();
    fireEvent.press(screen.getByTestId(`event-vendor-${IG_VENDOR}`));
    fireEvent.press(screen.getByTestId('event-vendor-card-instagram'));
    expectLoginOnly();
    expect(openURL).not.toHaveBeenCalled();
    expect(recordBoothEvent).not.toHaveBeenCalledWith(EVENT.id, IG_VENDOR, 'instagram_tap');

    fireEvent.press(screen.getByTestId('event-vendors-find-booth'));
    expectLoginOnly();
    expect(screen.queryByText('Tap Claim on your booth')).toBeNull();

    await act(async () => fireEvent.press(screen.getByTestId('booth-claim')));
    expectLoginOnly();
    expect(claimBooth).not.toHaveBeenCalled();
  });

  it('message, follow, report and the holder profile on a claimed booth', async () => {
    jest.mocked(fetchBoothClaims).mockResolvedValue(claimedByOther());
    await renderShow();
    fireEvent.press(screen.getByTestId(`event-vendor-${VENDOR}`));
    await screen.findByTestId('booth-holder');

    fireEvent.press(screen.getByTestId('booth-holder'));
    expectLoginOnly();

    await act(async () => fireEvent.press(screen.getByTestId('booth-message')));
    expectLoginOnly();
    expect(findOrCreateDm).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByTestId('booth-follow')).toBeEnabled());
    await act(async () => fireEvent.press(screen.getByTestId('booth-follow')));
    expectLoginOnly();
    expect(followUser).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(screen.getByTestId('booth-report')));
    expectLoginOnly();
    expect(reportBoothClaim).not.toHaveBeenCalled();
  });

  it('booth stories and booth photo posts', async () => {
    jest.mocked(fetchBoothPosts).mockResolvedValue([boothPost('p1')]);
    await renderShow();

    fireEvent.press(await screen.findByTestId(`booth-story-${VENDOR}`));
    expectLoginOnly();

    fireEvent.press(screen.getByTestId(`event-vendor-${VENDOR}`));
    fireEvent.press(await screen.findByTestId('booth-strip-p1'));
    expectLoginOnly();
    expect(recordBoothEvent).not.toHaveBeenCalledWith(EVENT.id, VENDOR, 'post_view');
  });
});

describe('guest on a show feed', () => {
  async function openFeed() {
    jest.mocked(fetchEventPosts).mockImplementation(async (_id, _limit, options) =>
      options?.boothOnly ? [] : [feedPost('a', { intent: 'selling', boothVendorId: VENDOR })],
    );
    await renderShow();
    fireEvent.press(within(screen.getByTestId('event-detail-show-area')).getByText('Feed'));
    return screen.findByTestId('event-feed-post-a');
  }

  it('commenting opens login: no thread, no comment written', async () => {
    const card = await openFeed();
    fireEvent.press(within(card).getByTestId('event-feed-post-comment-button'));
    expectLoginOnly();
    expect(screen.queryByTestId('event-feed-post-comments-input')).toBeNull();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('like, repost, share and the author open login and write nothing', async () => {
    const card = await openFeed();
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

  it('type filters and "Find on map" stay open', async () => {
    await openFeed();
    fireEvent.press(screen.getByTestId('event-feed-intent-selling'));
    await waitFor(() => expect(fetchEventPosts).toHaveBeenCalledWith(EVENT.id, 20, { intent: 'selling' }));
    fireEvent.press(await screen.findByTestId('event-feed-post-find-on-map'));
    expect(await screen.findByTestId('event-vendor-card-name')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
