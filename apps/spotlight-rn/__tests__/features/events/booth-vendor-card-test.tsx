import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import { mockSpotlightEventMap, type SpotlightEventMap } from '@spotlight/api-client';
import type { BoothClaim, BoothPost } from '@/features/events/booth-service';
import {
  claimBooth,
  fetchBoothClaims,
  fetchBoothPosts,
  fetchBoothStats,
  fetchBrowsingNow,
  fetchHotBooths,
  recordBoothEvent,
  reportBoothClaim,
  suggestMyBooth,
  touchEventPresence,
  unclaimBooth,
} from '@/features/events/booth-service';
import { resetSavedEventsForTests } from '@/features/events/saved-events-store';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';
import { followUser } from '@/features/profile/profile-service';
import { findOrCreateDm } from '@/features/social/dm-service';
import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { makeEvent } from './event-fixtures';

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

jest.mock('@/features/events/booth-service', () => ({
  claimBooth: jest.fn(async () => 'claimed'),
  unclaimBooth: jest.fn(async () => true),
  reportBoothClaim: jest.fn(async () => true),
  recordBoothEvent: jest.fn(),
  fetchBoothClaims: jest.fn(async () => new Map()),
  fetchBoothPosts: jest.fn(async () => []),
  fetchBoothStats: jest.fn(async () => ({
    views: 0,
    instagramTaps: 0,
    messages: 0,
    postViews: 0,
    viewers: 0,
    viewsToday: 0,
  })),
  touchEventPresence: jest.fn(),
  fetchBrowsingNow: jest.fn(async () => null),
  suggestMyBooth: jest.fn(async () => []),
  fetchHotBooths: jest.fn(async () => []),
}));

// Booth UI only renders with a Supabase client configured.
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

jest.mock('@/features/social/components/post-card', () => {
  const { View } = require('react-native');
  return {
    PostImage: ({ compact, testID, uri }: { compact?: boolean; testID?: string; uri: string }) => (
      <View compact={compact} testID={testID ?? `post-image:${uri}`} />
    ),
    postMediaUrl: (base: string, id: string, options?: { displayWidth?: number }) =>
      `${base}/api/v1/post-media/${id}?display=${options?.displayWidth}`,
  };
});

jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: jest.fn(),
}));

jest.mock('@/providers/app-providers', () => ({
  ...jest.requireActual('@/providers/app-providers'),
  resolveRepositoryBaseUrl: () => 'https://api.example.com',
}));

const ME = 'user-me';
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({
    accessToken: 'token',
    applyFollowingDelta: jest.fn(),
    currentUser: { id: 'user-me' },
    ensureGuestSession: jest.fn(),
    isGuest: false,
  }),
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
      removeItem: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
      getAllKeys: jest.fn(() => Promise.resolve([...store.keys()])),
      multiGet: jest.fn((keys: string[]) => Promise.resolve(keys.map((key) => [key, store.get(key) ?? null]))),
      multiSet: jest.fn((pairs: [string, string][]) => {
        pairs.forEach(([key, value]) => store.set(key, value));
        return Promise.resolve();
      }),
      multiRemove: jest.fn((keys: string[]) => {
        keys.forEach((key) => store.delete(key));
        return Promise.resolve();
      }),
    },
  };
});

const EVENT = makeEvent({ floorMapUrl: 'https://example.com/api/v1/events/hawaii-2026-10/map' });
const VENDOR = 'main-street-cards';

function claim(userId: string, handle: string | null = 'islandslabs'): Map<string, BoothClaim> {
  return new Map([[VENDOR, { vendorId: VENDOR, userId, handle, claimedAt: '2026-10-29T00:00:00Z' }]]);
}

function boothPost(id: string, vendorId = VENDOR, createdAt = new Date().toISOString()): BoothPost {
  return {
    id,
    authorId: 'user-2',
    author: null,
    body: 'Case is up',
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt,
    media: [{ id: `${id}-m`, width: 900, height: 1200, blurhash: null }],
    boothVendorId: vendorId,
  };
}

/** Before tables are assigned (tools/build_event_floor_map.py --vendors-only). */
const VENDORS_ONLY_MAP: SpotlightEventMap = {
  ...mockSpotlightEventMap,
  imageUrl: null,
  imageWidth: 0,
  imageHeight: 0,
  tables: [],
  vendors: mockSpotlightEventMap.vendors.map((vendor) => ({ ...vendor, location: '', tableIds: [] })),
};

async function renderShow(initialVendorId: string | null = null, map: SpotlightEventMap = mockSpotlightEventMap) {
  renderWithProviders(<EventDetailScreen eventId={EVENT.id} initialVendorId={initialVendorId} onBack={jest.fn()} />, {
    spotlightRepository: createTestSpotlightRepository({
      fetchSpotlightEvents: async () => ({ items: [EVENT] }),
      fetchSpotlightEventMap: async () => map,
    }),
  });
  if (map.tables.length > 0) {
    fireEvent(await screen.findByTestId('event-floor-map'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 440 } },
    });
  }
  await waitFor(() => expect(fetchBoothClaims).toHaveBeenCalled());
}

async function openVendor() {
  fireEvent.press(screen.getByTestId(`event-vendor-${VENDOR}`));
  await screen.findByTestId('booth-panel');
}

describe('booth vendor card', () => {
  let alert: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    alert.mockRestore();
  });

  it('unclaimed: "This is my booth" claims it, confirms, and re-reads claims', async () => {
    await renderShow();
    await openVendor();
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, VENDOR, 'card_open');
    expect(capturePostHogEvent).toHaveBeenCalledWith('booth_card_opened', expect.objectContaining({ vendor_id: VENDOR }));
    const before = jest.mocked(fetchBoothClaims).mock.calls.length;

    await act(async () => fireEvent.press(screen.getByTestId('booth-claim')));
    expect(claimBooth).toHaveBeenCalledWith(VENDOR, EVENT.id);
    expect(alert).toHaveBeenCalledWith('Booth claimed', expect.any(String));
    expect(capturePostHogEvent).toHaveBeenCalledWith('booth_claimed', {
      event_id: EVENT.id,
      vendor_id: VENDOR,
      source: 'card',
    });
    expect(jest.mocked(fetchBoothClaims).mock.calls.length).toBeGreaterThan(before);
  });

  it('unclaimed: an unauthenticated claim opens sign-in; a limit shows an alert', async () => {
    jest.mocked(claimBooth).mockResolvedValueOnce('unauthenticated').mockResolvedValueOnce('limit');
    await renderShow();
    await openVendor();
    await act(async () => fireEvent.press(screen.getByTestId('booth-claim')));
    expect(mockPush).toHaveBeenCalledWith('/login');
    await act(async () => fireEvent.press(screen.getByTestId('booth-claim')));
    expect(alert).toHaveBeenCalledWith('Booth limit reached', expect.any(String));
  });

  it('claimed by someone else: handle, Message, Follow and Report', async () => {
    jest.mocked(fetchBoothClaims).mockResolvedValue(claim('user-2'));
    await renderShow();
    await openVendor();
    expect(screen.queryByTestId('booth-claim')).toBeNull();

    fireEvent.press(await screen.findByText('@islandslabs'));
    expect(mockPush).toHaveBeenCalledWith('/u/islandslabs');

    await act(async () => fireEvent.press(screen.getByTestId('booth-message')));
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, VENDOR, 'message_start');
    expect(findOrCreateDm).toHaveBeenCalledWith('user-2');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/messages/[conversationId]',
      params: { conversationId: 'conv-1', name: '@islandslabs' },
    });

    await waitFor(() => expect(screen.getByTestId('booth-follow')).toBeEnabled());
    await act(async () => fireEvent.press(screen.getByTestId('booth-follow')));
    expect(followUser).toHaveBeenCalledWith('user-2');
    expect(screen.getByText('Following')).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByTestId('booth-report')));
    expect(reportBoothClaim).toHaveBeenCalledWith(VENDOR);
    expect(alert).toHaveBeenCalledWith('Thanks for letting us know', expect.any(String));
  });

  it('records Instagram taps on a vendor card', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderShow();
    await openVendor();
    fireEvent.press(screen.getByTestId('event-vendor-card-instagram'));
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, VENDOR, 'instagram_tap');
  });

  it('mine: stats, Post to your booth, and Unclaim; my own opens are not counted', async () => {
    jest.mocked(fetchBoothClaims).mockResolvedValue(claim(ME));
    jest.mocked(fetchBoothStats).mockResolvedValue({
      views: 63,
      instagramTaps: 14,
      messages: 1,
      postViews: 0,
      viewers: 40,
      viewsToday: 20,
    });
    await renderShow();
    await openVendor();
    expect(await screen.findByTestId('booth-mine')).toBeTruthy();
    expect(await screen.findByText('Your booth: 63 views · 14 Instagram taps · 1 message')).toBeTruthy();
    expect(fetchBoothStats).toHaveBeenCalledWith(VENDOR, EVENT.id);
    expect(capturePostHogEvent).toHaveBeenCalledWith('booth_stats_viewed', { event_id: EVENT.id, vendor_id: VENDOR });
    expect(recordBoothEvent).not.toHaveBeenCalledWith(EVENT.id, VENDOR, 'card_open');

    fireEvent.press(screen.getByTestId('booth-post'));
    expect(mockPush).toHaveBeenCalledWith(`/new-post?eventId=${EVENT.id}&vendorId=${VENDOR}`);

    fireEvent.press(screen.getByTestId('booth-unclaim'));
    const buttons = alert.mock.calls.at(-1)?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((button) => button.text === 'Unclaim')?.onPress?.());
    expect(unclaimBooth).toHaveBeenCalledWith(VENDOR);
  });

  it('shows booth photos on the card, a pin dot, and the "From the floor" row', async () => {
    jest.mocked(fetchBoothPosts).mockResolvedValue([boothPost('p1')]);
    await renderShow();
    const floorCard = await screen.findByTestId('booth-floor-p1');
    expect(screen.getByText('C14 · now')).toBeTruthy();
    expect(screen.getByTestId('event-floor-map-posted-C14')).toBeTruthy();

    // A "From the floor" card selects its vendor on the map.
    fireEvent.press(floorCard);
    expect(screen.getByTestId('event-vendor-card-name').props.children).toBe(
      mockSpotlightEventMap.vendors.find((vendor) => vendor.id === VENDOR)?.name,
    );

    // Both surfaces ask for a thumbnail sized to their frame; the 48pt strip
    // thumb also uses the compact (icon-only) placeholder.
    expect(screen.getByTestId('post-image:https://api.example.com/api/v1/post-media/p1-m?display=120')).toBeTruthy();
    const stripThumb = await screen.findByTestId('post-image:https://api.example.com/api/v1/post-media/p1-m?display=48');
    expect(stripThumb.props.compact).toBe(true);

    fireEvent.press(await screen.findByTestId('booth-strip-p1'));
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, VENDOR, 'post_view');
    expect(mockPush).toHaveBeenCalledWith('/post/p1');
  });

  it('no dot for a post older than a day, and no row or strip without posts', async () => {
    jest.mocked(fetchBoothPosts).mockResolvedValue([boothPost('old', VENDOR, '2026-01-01T00:00:00Z')]);
    await renderShow();
    await screen.findByTestId('booth-floor-old');
    expect(screen.queryByTestId('event-floor-map-posted-C14')).toBeNull();

    screen.unmount();
    jest.mocked(fetchBoothPosts).mockResolvedValue([]);
    await renderShow();
    expect(screen.queryByTestId('booth-floor-row')).toBeNull();
    await openVendor();
    expect(screen.queryByTestId('booth-strip')).toBeNull();
  });

  it('opens with the deep-linked vendor selected', async () => {
    await renderShow(VENDOR);
    expect(await screen.findByTestId('event-vendor-card')).toBeTruthy();
    expect(screen.getByTestId(`event-vendor-${VENDOR}`).props.accessibilityState).toMatchObject({ selected: true });
  });

  it('heartbeats presence and shows "browsing now" only from 3 people', async () => {
    jest.mocked(fetchBrowsingNow).mockResolvedValue(5);
    await renderShow();
    expect(touchEventPresence).toHaveBeenCalledWith(EVENT.id);
    expect(await screen.findByText('5 people browsing now')).toBeTruthy();

    screen.unmount();
    jest.mocked(fetchBrowsingNow).mockResolvedValue(2);
    await renderShow();
    await waitFor(() => expect(fetchBrowsingNow).toHaveBeenCalled());
    expect(screen.queryByTestId('event-browsing-now')).toBeNull();
  });
});

describe('vendors-only show (no tables yet)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks keeps the claims/posts the suite above left mocked.
    jest.mocked(fetchBoothClaims).mockResolvedValue(new Map());
    jest.mocked(fetchBoothPosts).mockResolvedValue([]);
    jest.mocked(fetchBrowsingNow).mockResolvedValue(null);
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('lists vendors under a "coming soon" note instead of the floor map', async () => {
    await renderShow(null, VENDORS_ONLY_MAP);
    expect(await screen.findByTestId('event-vendors-tables-pending')).toBeTruthy();
    expect(screen.getByText('Table assignments coming soon')).toBeTruthy();
    expect(screen.queryByTestId('event-floor-map')).toBeNull();
    for (const vendor of VENDORS_ONLY_MAP.vendors) {
      expect(screen.getByTestId(`event-vendor-${vendor.id}`)).toBeTruthy();
    }
    expect(fetchBoothClaims).toHaveBeenCalledWith(VENDORS_ONLY_MAP.vendors.map((vendor) => vendor.id));

    fireEvent.changeText(screen.getByTestId('event-vendors-search'), 'main');
    expect(screen.queryByTestId('event-vendor-aloha-puddin')).toBeNull();
    expect(screen.getByTestId(`event-vendor-${VENDOR}`)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('event-vendors-search'), '');
    fireEvent.press(screen.getByTestId('event-vendors-tag-Food'));
    expect(screen.queryByTestId(`event-vendor-${VENDOR}`)).toBeNull();
    expect(screen.getByTestId('event-vendor-aloha-puddin')).toBeTruthy();
  });

  it('a tapped vendor opens the full booth card in the list, and it can be claimed', async () => {
    await renderShow(null, VENDORS_ONLY_MAP);
    await openVendor();
    expect(screen.getByTestId('event-vendor-card-name').props.children).toBe('Main Street Cards');
    expect(screen.getByText('Table TBA')).toBeTruthy();
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, VENDOR, 'card_open');
    await act(async () => fireEvent.press(screen.getByTestId('booth-claim')));
    expect(claimBooth).toHaveBeenCalledWith(VENDOR, EVENT.id);

    fireEvent.press(screen.getByTestId('event-vendor-card-close'));
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();
    expect(screen.getByTestId(`event-vendor-${VENDOR}`)).toBeTruthy();
  });

  it('mine: stats and Post to your booth work without tables', async () => {
    jest.mocked(fetchBoothClaims).mockResolvedValue(claim(ME));
    await renderShow(null, VENDORS_ONLY_MAP);
    await openVendor();
    expect(await screen.findByTestId('booth-mine')).toBeTruthy();
    expect(fetchBoothStats).toHaveBeenCalledWith(VENDOR, EVENT.id);
    fireEvent.press(screen.getByTestId('booth-post'));
    expect(mockPush).toHaveBeenCalledWith(`/new-post?eventId=${EVENT.id}&vendorId=${VENDOR}`);
  });

  it('"From the floor", deep links and browsing count still work', async () => {
    jest.mocked(fetchBoothPosts).mockResolvedValue([boothPost('p1')]);
    jest.mocked(fetchBrowsingNow).mockResolvedValue(4);
    await renderShow(null, VENDORS_ONLY_MAP);
    const floorCard = await screen.findByTestId('booth-floor-p1');
    expect(floorCard.props.accessibilityLabel).toBe('Main Street Cards, table tba');
    expect(screen.getByText('now')).toBeTruthy();
    expect(await screen.findByText('4 people browsing now')).toBeTruthy();
    fireEvent.press(floorCard);
    expect(screen.getByTestId('event-vendor-card-name').props.children).toBe('Main Street Cards');
    expect(await screen.findByTestId('booth-strip-p1')).toBeTruthy();

    screen.unmount();
    await renderShow(VENDOR, VENDORS_ONLY_MAP);
    expect(await screen.findByTestId('booth-panel')).toBeTruthy();
  });
});

describe('one-tap claim from the list', () => {
  let alert: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(fetchBoothClaims).mockResolvedValue(new Map());
    jest.mocked(fetchBoothPosts).mockResolvedValue([]);
    jest.mocked(fetchBrowsingNow).mockResolvedValue(null);
    jest.mocked(suggestMyBooth).mockResolvedValue([]);
    jest.mocked(fetchHotBooths).mockResolvedValue([]);
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    alert.mockRestore();
  });

  it('"This is you": an email-matched vendor is pinned with one-tap Claim booth', async () => {
    jest.mocked(suggestMyBooth).mockResolvedValue([VENDOR]);
    await renderShow();
    expect(suggestMyBooth).toHaveBeenCalledWith(EVENT.id);
    const card = await screen.findByTestId(`event-vendor-you-${VENDOR}`);
    expect(card).toBeTruthy();
    expect(screen.getByText('Main Street Cards · This is you')).toBeTruthy();

    jest.mocked(fetchBoothClaims).mockResolvedValue(claim(ME));
    await act(async () => fireEvent.press(screen.getByTestId(`event-vendor-you-claim-${VENDOR}`)));
    expect(claimBooth).toHaveBeenCalledWith(VENDOR, EVENT.id);
    expect(capturePostHogEvent).toHaveBeenCalledWith('booth_claimed', {
      event_id: EVENT.id,
      vendor_id: VENDOR,
      source: 'suggestion',
    });
    // Mine now: the pinned card goes, the row carries "Your booth".
    await waitFor(() => expect(screen.queryByTestId(`event-vendor-you-${VENDOR}`)).not.toBeOnTheScreen());
    expect(screen.getByTestId(`event-vendor-mine-${VENDOR}`)).toBeTruthy();
  });

  it('"This is you" on a booth someone else holds offers Report instead', async () => {
    jest.mocked(suggestMyBooth).mockResolvedValue([VENDOR]);
    jest.mocked(fetchBoothClaims).mockResolvedValue(claim('user-2'));
    await renderShow();
    expect(await screen.findByText('Claimed by @islandslabs')).toBeTruthy();
    expect(screen.queryByTestId(`event-vendor-you-claim-${VENDOR}`)).toBeNull();
    await act(async () => fireEvent.press(screen.getByTestId(`event-vendor-you-report-${VENDOR}`)));
    expect(reportBoothClaim).toHaveBeenCalledWith(VENDOR);
  });

  it('claim mode: Claim pills on unclaimed rows, "Claimed" on held ones, Done exits', async () => {
    const other = mockSpotlightEventMap.vendors.find((vendor) => vendor.id !== VENDOR)!;
    jest.mocked(fetchBoothClaims).mockResolvedValue(
      new Map([[other.id, { vendorId: other.id, userId: 'user-2', handle: null, claimedAt: '2026-10-29T00:00:00Z' }]]),
    );
    await renderShow();
    expect(screen.queryByTestId(`event-vendor-claim-${VENDOR}`)).toBeNull();

    fireEvent.press(await screen.findByTestId('event-vendors-find-booth'));
    expect(screen.getByTestId(`event-vendor-claim-${VENDOR}`)).toBeTruthy();
    expect(screen.getByTestId(`event-vendor-claimed-${other.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`event-vendor-claim-${other.id}`)).toBeNull();

    await act(async () => fireEvent.press(screen.getByTestId(`event-vendor-claim-${VENDOR}`)));
    expect(claimBooth).toHaveBeenCalledWith(VENDOR, EVENT.id);
    expect(capturePostHogEvent).toHaveBeenCalledWith('booth_claimed', {
      event_id: EVENT.id,
      vendor_id: VENDOR,
      source: 'list',
    });
    // The pill claims without opening the card.
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();

    fireEvent.press(screen.getByTestId('event-vendors-claim-done'));
    expect(screen.queryByTestId(`event-vendor-claim-${VENDOR}`)).toBeNull();
    expect(screen.queryByTestId(`event-vendor-claimed-${other.id}`)).toBeNull();
  });

  it('your booth row: "Your booth" + Post opens the composer for that booth', async () => {
    jest.mocked(fetchBoothClaims).mockResolvedValue(claim(ME));
    await renderShow(null, VENDORS_ONLY_MAP);
    expect(await screen.findByTestId(`event-vendor-mine-${VENDOR}`)).toBeTruthy();
    fireEvent.press(screen.getByTestId(`event-vendor-post-${VENDOR}`));
    expect(mockPush).toHaveBeenCalledWith(`/new-post?eventId=${EVENT.id}&vendorId=${VENDOR}`);
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();
  });

  it('hot booths get a flame on the row and a glow on their tables', async () => {
    jest.mocked(fetchHotBooths).mockResolvedValue([VENDOR]);
    await renderShow();
    expect(fetchHotBooths).toHaveBeenCalledWith(EVENT.id);
    expect(await screen.findByTestId(`event-vendor-hot-${VENDOR}`)).toBeTruthy();
    expect(screen.getByTestId('event-floor-map-hot-C14')).toBeTruthy();
    const others = mockSpotlightEventMap.vendors.filter((vendor) => vendor.id !== VENDOR);
    for (const vendor of others) {
      expect(screen.queryByTestId(`event-vendor-hot-${vendor.id}`)).toBeNull();
    }
  });

  it('vendors-only shows: the flame is on the row only', async () => {
    jest.mocked(fetchHotBooths).mockResolvedValue([VENDOR]);
    await renderShow(null, VENDORS_ONLY_MAP);
    expect(await screen.findByTestId(`event-vendor-hot-${VENDOR}`)).toBeTruthy();
    expect(screen.queryByTestId('event-floor-map')).toBeNull();
  });
});
