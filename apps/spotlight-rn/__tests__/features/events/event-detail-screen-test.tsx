import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { Linking, Platform, Share } from 'react-native';

import { mockSpotlightEventMap, mockSpotlightEventPricing, type SpotlightEventsFeed } from '@spotlight/api-client';
import { resetSavedEventsForTests } from '@/features/events/saved-events-store';
import { EventDetailScreen, formatTicketPrice, openEventInMaps } from '@/features/events/screens/event-detail-screen';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { makeEvent, pastFeatured, upcomingFeatured } from './event-fixtures';

jest.mock('@/features/meta-feed/screens/components/open-link-out', () => ({
  openLinkOut: jest.fn(async () => undefined),
}));

// react-native-maps needs a native view manager; the map itself has its own test.
jest.mock('@/features/events/components/event-map', () => {
  const { View } = require('react-native');
  return {
    EventMap: ({ testID, latitude, longitude }: { testID?: string; latitude: number; longitude: number }) => (
      <View accessibilityLabel={`${latitude},${longitude}`} testID={testID} />
    ),
  };
});

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
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

const noCoordsNoTickets = makeEvent({
  id: 'tba-2027-03',
  title: 'Spotlight at a Venue TBA',
  latitude: null,
  longitude: null,
  ticketUrl: null,
  categories: [],
  shareUrl: 'https://example.com/e/tba',
});

const FEED: SpotlightEventsFeed = { items: [upcomingFeatured, pastFeatured, noCoordsNoTickets] };

function renderDetail(eventId: string, fetchSpotlightEvents: () => Promise<SpotlightEventsFeed | null> = async () => FEED) {
  const onBack = jest.fn();
  renderWithProviders(<EventDetailScreen eventId={eventId} onBack={onBack} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchSpotlightEvents }),
  });
  return { onBack };
}

describe('EventDetailScreen', () => {
  beforeEach(async () => {
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    jest.mocked(openLinkOut).mockClear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders title, schedule, categories and the map for an upcoming event', async () => {
    renderDetail('hawaii-2026-10');
    expect((await screen.findByTestId('event-detail-title')).props.children).toBe(
      'Spotlight at the Hawaii Convention Center',
    );
    expect(screen.getAllByText('10/24–10/25, 10:00AM - 5:00PM').length).toBeGreaterThan(0);
    const categories = screen.getByTestId('event-detail-categories');
    for (const category of upcomingFeatured.categories) {
      expect(within(categories).getByText(category)).toBeTruthy();
    }
    expect(screen.getByText('275+ Tables')).toBeTruthy();
    expect(screen.getByText(upcomingFeatured.address)).toBeTruthy();
    expect(screen.queryByTestId('event-detail-map')).toBeNull();
  });

  it('renders the PRICING section from the event pricing block, and hides it when absent', async () => {
    renderDetail('hawaii-2026-10');
    await screen.findByTestId('event-detail-title');
    const pricing = screen.getByTestId('event-detail-pricing');
    expect(within(pricing).getByText('$10 general ($15 at the door)')).toBeTruthy();
    for (const note of mockSpotlightEventPricing.notes) {
      expect(within(pricing).getByText(note)).toBeTruthy();
    }
    expect(within(pricing).getByText(mockSpotlightEventPricing.disclaimer ?? '')).toBeTruthy();

    screen.unmount();
    renderDetail('ontario-2026-08');
    await screen.findByTestId('event-detail-title');
    expect(screen.queryByTestId('event-detail-pricing')).toBeNull();
  });

  it('shows Buy Tickets for an upcoming ticketed event and opens the link', async () => {
    renderDetail('hawaii-2026-10');
    fireEvent.press(await screen.findByTestId('event-detail-buy'));
    expect(openLinkOut).toHaveBeenCalledWith('https://example.com/tickets/hawaii');
  });

  it('hides Buy Tickets for a past event, even with a ticket link, and shows the table count', async () => {
    renderDetail('ontario-2026-08', async () => ({
      items: [{ ...pastFeatured, ticketUrl: 'https://example.com/tickets/ontario' }],
    }));
    await screen.findByTestId('event-detail-title');
    expect(screen.getByText('275+ Tables')).toBeTruthy();
    expect(screen.queryByTestId('event-detail-buy')).toBeNull();
  });

  it('hides Buy Tickets and the map when there is no ticket link or coordinates', async () => {
    renderDetail('tba-2027-03');
    await screen.findByTestId('event-detail-title');
    expect(screen.queryByTestId('event-detail-buy')).toBeNull();
    expect(screen.queryByTestId('event-detail-map')).toBeNull();
    expect(screen.queryByTestId('event-detail-categories')).toBeNull();
  });

  it('toggles the saved heart', async () => {
    renderDetail('hawaii-2026-10');
    await screen.findByTestId('event-detail-title');
    const save = () => screen.getByTestId('event-detail-save');
    expect(save().props.accessibilityLabel).toBe('Save event');

    fireEvent.press(save());
    expect(save().props.accessibilityLabel).toBe('Remove from saved events');
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      '@spotlight/events/saved/anonymous',
      JSON.stringify(['hawaii-2026-10']),
    );

    fireEvent.press(save());
    expect(save().props.accessibilityLabel).toBe('Save event');
  });

  it('shares with the url when the event has a share link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    renderDetail('tba-2027-03');
    await screen.findByTestId('event-detail-title');
    fireEvent.press(screen.getByTestId('event-detail-share'));
    expect(share).toHaveBeenCalledWith({
      message: expect.stringContaining('Spotlight at a Venue TBA'),
      url: 'https://example.com/e/tba',
    });
  });

  it('shares a message only (with the ticket link inside) when there is no share link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    renderDetail('hawaii-2026-10');
    await screen.findByTestId('event-detail-title');
    fireEvent.press(screen.getByTestId('event-detail-share'));
    const payload = share.mock.calls[0][0] as { message: string; url?: string };
    expect(payload.url).toBeUndefined();
    expect(payload.message).toContain('https://example.com/tickets/hawaii');
  });

  it('shows the error card when the event cannot be loaded', async () => {
    renderDetail('hawaii-2026-10', async () => null);
    expect(await screen.findByTestId('event-detail-error')).toBeTruthy();
    expect(screen.queryByTestId('event-detail-buy')).toBeNull();
  });

  it('calls onBack from the back button', async () => {
    const { onBack } = renderDetail('hawaii-2026-10');
    await screen.findByTestId('event-detail-title');
    fireEvent.press(screen.getByTestId('event-detail-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('opens Maps from the address row', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    renderDetail('hawaii-2026-10');
    await screen.findByTestId('event-detail-title');
    fireEvent.press(screen.getByTestId('event-detail-address'));
    expect(openURL).toHaveBeenCalledTimes(1);
  });
});

describe('formatTicketPrice', () => {
  it('appends the door price in parentheses when there is one', () => {
    expect(formatTicketPrice({ general: '$10 general', doorPrice: '$15 at the door' })).toBe('$10 general ($15 at the door)');
    expect(formatTicketPrice({ general: '$10 general', doorPrice: null })).toBe('$10 general');
  });
});

describe('openEventInMaps', () => {
  const event = {
    title: 'Spotlight Hawaii',
    address: '1801 Kalakaua Ave, Honolulu, HI',
    latitude: 21.29,
    longitude: -157.84,
  };
  const originalOS = Platform.OS;

  function setOS(os: typeof Platform.OS) {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
  }

  let openURL: jest.SpyInstance;
  beforeEach(() => {
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  afterEach(() => {
    setOS(originalOS);
    jest.restoreAllMocks();
  });

  it('uses Apple Maps on iOS with the address query and coordinates', () => {
    setOS('ios');
    openEventInMaps(event);
    expect(openURL).toHaveBeenCalledWith(
      'http://maps.apple.com/?q=1801%20Kalakaua%20Ave%2C%20Honolulu%2C%20HI&ll=21.29,-157.84',
    );
  });

  it('uses Apple Maps without ll when there are no coordinates, and the title when there is no address', () => {
    setOS('ios');
    openEventInMaps({ ...event, address: '', latitude: null, longitude: null });
    expect(openURL).toHaveBeenCalledWith('http://maps.apple.com/?q=Spotlight%20Hawaii');
  });

  it('uses a geo: URI with a labeled pin on Android', () => {
    setOS('android');
    openEventInMaps(event);
    expect(openURL).toHaveBeenCalledWith('geo:21.29,-157.84?q=21.29,-157.84(Spotlight%20Hawaii)');
  });

  it('falls back to an address search on Android without coordinates', () => {
    setOS('android');
    openEventInMaps({ ...event, latitude: null, longitude: null });
    expect(openURL).toHaveBeenCalledWith('geo:0,0?q=1801%20Kalakaua%20Ave%2C%20Honolulu%2C%20HI');
  });
});

describe('EventDetailScreen vendors', () => {
  const withMap = makeEvent({ floorMapUrl: 'https://example.com/api/v1/events/hawaii-2026-10/map' });

  function renderWithMap(event = withMap) {
    const fetchSpotlightEventMap = jest.fn(async () => mockSpotlightEventMap);
    renderWithProviders(<EventDetailScreen eventId={event.id} onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({
        fetchSpotlightEvents: async () => ({ items: [event] }),
        fetchSpotlightEventMap,
      }),
    });
    return { fetchSpotlightEventMap };
  }

  beforeEach(async () => {
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is absent, and never fetches, when the event has no floor map', async () => {
    const { fetchSpotlightEventMap } = renderWithMap(makeEvent({ floorMapUrl: null }));
    await screen.findByTestId('event-detail-title');
    expect(screen.queryByTestId('event-vendors')).toBeNull();
    expect(fetchSpotlightEventMap).not.toHaveBeenCalled();
  });

  it('lists vendors and filters them by search and tag', async () => {
    const { fetchSpotlightEventMap } = renderWithMap();
    expect(await screen.findByTestId('event-vendors')).toBeTruthy();
    expect(fetchSpotlightEventMap).toHaveBeenCalledWith(withMap.floorMapUrl);
    for (const vendor of mockSpotlightEventMap.vendors) {
      expect(screen.getByTestId(`event-vendor-${vendor.id}`)).toBeTruthy();
    }

    fireEvent.changeText(screen.getByTestId('event-vendors-search'), 'main');
    expect(screen.getByTestId('event-vendor-main-street-cards')).toBeTruthy();
    expect(screen.queryByTestId('event-vendor-aloha-puddin')).toBeNull();

    fireEvent.changeText(screen.getByTestId('event-vendors-search'), '');
    fireEvent.press(screen.getByTestId('event-vendors-tag-Food'));
    expect(screen.getByTestId('event-vendor-aloha-puddin')).toBeTruthy();
    expect(screen.queryByTestId('event-vendor-main-street-cards')).toBeNull();
  });

  it('selecting a vendor shows its card, highlights its tables, opens Instagram, and a second tap deselects', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    renderWithMap();
    fireEvent(await screen.findByTestId('event-floor-map'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 440 } },
    });
    fireEvent.press(screen.getByTestId('event-vendor-dokidoki-collectibles'));

    expect(screen.getByTestId('event-vendor-card-name').props.children).toBe('DokiDokiCollectibles');
    // No logo -> initials, beside the name in both the row and the card.
    expect(screen.getAllByTestId('event-vendor-avatar-dokidoki-collectibles')).toHaveLength(2);
    expect(screen.getAllByText('D').length).toBeGreaterThan(0);
    expect(screen.getByTestId('event-floor-map-highlight-A1')).toBeTruthy();
    expect(screen.getByTestId('event-floor-map-highlight-A2')).toBeTruthy();
    expect(screen.queryByTestId('event-floor-map-highlight-C14')).toBeNull();

    expect(screen.getByText('Table A1-A2')).toBeTruthy();
    expect(screen.getByTestId('event-vendor-dokidoki-collectibles').props.accessibilityState).toMatchObject({
      selected: true,
    });

    fireEvent.press(screen.getByTestId('event-vendor-card-instagram'));
    expect(openURL).toHaveBeenCalledWith('https://instagram.com/dokidokicollectibles');

    fireEvent.press(screen.getByTestId('event-vendor-dokidoki-collectibles'));
    expect(screen.queryByTestId('event-vendor-card')).toBeNull();
  });

  it('has no Instagram button for a vendor without a handle', async () => {
    renderWithMap();
    fireEvent.press(await screen.findByTestId('event-vendor-aloha-puddin'));
    expect(screen.getByTestId('event-vendor-card')).toBeTruthy();
    expect(screen.queryByTestId('event-vendor-card-instagram')).toBeNull();
  });
});
