import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen } from '@testing-library/react-native';
import { Share, Text } from 'react-native';

import type { SpotlightEventsFeed } from '@spotlight/api-client';
import { resetSavedEventsForTests } from '@/features/events/saved-events-store';
import {
  EventsScreen,
  buildEventsShareMessage,
  searchEvents,
} from '@/features/events/screens/events-screen';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { useAppDrawer } from '@/providers/app-drawer-provider';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { makeEvent, pastFeatured, upcomingFeatured } from './event-fixtures';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@/features/meta-feed/screens/components/open-link-out', () => ({
  openLinkOut: jest.fn(async () => undefined),
}));

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

const laterTicketed = makeEvent({
  id: 'pomona-2026-12',
  shortTitle: 'Spotlight Pomona',
  title: 'Spotlight at the Pomona Fairplex',
  city: 'Pomona, CA',
  startDate: '2026-12-05',
  endDate: '2026-12-06',
  featured: false,
  ticketUrl: 'https://example.com/tickets/pomona',
});
const upcomingNoTickets = makeEvent({
  id: 'irvine-2027-01',
  shortTitle: 'Spotlight Irvine',
  city: 'Irvine, CA',
  startDate: '2027-01-09',
  endDate: '2027-01-09',
  featured: true,
  ticketUrl: null,
});
const pastTicketed = { ...pastFeatured, ticketUrl: 'https://example.com/tickets/ontario' };

const FEED: SpotlightEventsFeed = {
  items: [upcomingFeatured, laterTicketed, upcomingNoTickets, pastTicketed],
};

function DrawerProbe() {
  const { isOpen } = useAppDrawer();
  return <Text testID="drawer-probe">{isOpen ? 'open' : 'closed'}</Text>;
}

function renderEvents(fetchSpotlightEvents: () => Promise<SpotlightEventsFeed | null> = async () => FEED) {
  return renderWithProviders(
    <>
      <EventsScreen />
      <DrawerProbe />
    </>,
    { spotlightRepository: createTestSpotlightRepository({ fetchSpotlightEvents }) },
  );
}

function cardIds() {
  return screen.queryAllByTestId(/^event-card-[^-]+-\d{4}-\d{2}$/).map((node) => node.props.testID);
}

describe('EventsScreen', () => {
  beforeEach(async () => {
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    mockPush.mockClear();
    jest.mocked(openLinkOut).mockClear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('has no featured carousel; upcoming shows are listed once', async () => {
    renderEvents();
    expect(await screen.findByTestId('event-card-hawaii-2026-10')).toBeTruthy();
    expect(screen.queryByTestId('events-featured')).toBeNull();
  });

  it('EVENTS lists only upcoming shows; PAST EVENTS lists the rest', async () => {
    renderEvents();
    await screen.findByTestId('event-card-hawaii-2026-10');
    expect(cardIds()).toEqual([
      'event-card-hawaii-2026-10',
      'event-card-pomona-2026-12',
      'event-card-irvine-2027-01',
    ]);
    expect(screen.getByTestId('events-title').props.children).toBe('Upcoming Spotlight events');

    fireEvent.press(screen.getByTestId('events-tabs-tab-past'));
    expect(cardIds()).toEqual(['event-card-ontario-2026-08']);
    expect(screen.getByTestId('events-title').props.children).toBe('Past Spotlight events');
  });

  it('PAST EVENTS shows an empty state when nothing is past', async () => {
    renderEvents(async () => ({ items: [upcomingFeatured] }));
    await screen.findByTestId('event-card-hawaii-2026-10');
    fireEvent.press(screen.getByTestId('events-tabs-tab-past'));
    expect(screen.getByTestId('events-past-empty')).toBeTruthy();
  });

  it('renders a region tab per state in the feed and filters by it', async () => {
    renderEvents();
    await screen.findByTestId('event-card-hawaii-2026-10');
    expect(screen.getByTestId('events-regions-tab-all')).toBeTruthy();
    expect(screen.getByTestId('events-regions-tab-HI')).toBeTruthy();
    expect(screen.getByTestId('events-regions-tab-CA')).toBeTruthy();
    expect(screen.queryByTestId('events-regions-tab-TX')).toBeNull();

    fireEvent.press(screen.getByTestId('events-regions-tab-CA'));
    expect(cardIds()).toEqual(['event-card-pomona-2026-12', 'event-card-irvine-2027-01']);
    // The region sticks across chips.
    fireEvent.press(screen.getByTestId('events-tabs-tab-past'));
    expect(cardIds()).toEqual(['event-card-ontario-2026-08']);
    fireEvent.press(screen.getByTestId('events-regions-tab-HI'));
    expect(screen.getByTestId('events-past-empty')).toBeTruthy();

    fireEvent.press(screen.getByTestId('events-tabs-tab-events'));
    fireEvent.press(screen.getByTestId('events-regions-tab-all'));
    expect(cardIds()).toHaveLength(3);
  });

  it('the toolbar search opens a field that filters by show, venue or city', async () => {
    renderEvents();
    await screen.findByTestId('event-card-hawaii-2026-10');
    expect(screen.queryByTestId('events-search-field')).toBeNull();

    fireEvent.press(screen.getByTestId('events-search'));
    fireEvent.changeText(screen.getByTestId('events-search-field'), 'pomona');
    expect(cardIds()).toEqual(['event-card-pomona-2026-12']);

    // Closing clears the query.
    fireEvent.press(screen.getByTestId('events-search'));
    expect(screen.queryByTestId('events-search-field')).toBeNull();
    expect(cardIds()).toHaveLength(3);
  });

  it('pushes the detail route when a card is pressed', async () => {
    renderEvents();
    fireEvent.press(await screen.findByTestId('event-card-pomona-2026-12'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/events/[eventId]', params: { eventId: 'pomona-2026-12' } });
  });

  it('Saved tab starts empty and fills when a card heart is tapped', async () => {
    renderEvents();
    await screen.findByTestId('event-card-hawaii-2026-10');

    fireEvent.press(screen.getByTestId('events-tabs-tab-saved'));
    expect(screen.getByTestId('events-saved-empty')).toBeTruthy();
    expect(cardIds()).toEqual([]);

    fireEvent.press(screen.getByTestId('events-tabs-tab-events'));
    const heart = screen.getByTestId('event-card-pomona-2026-12-save');
    expect(heart.props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(heart);
    expect(screen.getByTestId('event-card-pomona-2026-12-save').props.accessibilityState).toMatchObject({
      selected: true,
    });

    fireEvent.press(screen.getByTestId('events-tabs-tab-saved'));
    expect(screen.queryByTestId('events-saved-empty')).toBeNull();
    expect(cardIds()).toEqual(['event-card-pomona-2026-12']);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      '@spotlight/events/saved/anonymous',
      JSON.stringify(['pomona-2026-12']),
    );
  });

  it('shows the error card when the read fails', async () => {
    renderEvents(async () => {
      throw new Error('offline');
    });
    expect(await screen.findByTestId('events-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load events")).toBeTruthy();
  });

  it('shows the error card when the route is absent (null feed)', async () => {
    renderEvents(async () => null);
    expect(await screen.findByTestId('events-error')).toBeTruthy();
  });

  it('retries from the error card', async () => {
    const fetchSpotlightEvents = jest.fn<Promise<SpotlightEventsFeed | null>, []>(async () => null);
    renderEvents(fetchSpotlightEvents);
    await screen.findByTestId('events-error');

    fetchSpotlightEvents.mockResolvedValueOnce(FEED);
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId('event-card-hawaii-2026-10')).toBeTruthy();
  });

  it('opens the app drawer from the menu button', async () => {
    renderEvents();
    await screen.findByTestId('event-card-hawaii-2026-10');
    expect(screen.getByTestId('drawer-probe').props.children).toBe('closed');
    fireEvent.press(screen.getByTestId('events-menu'));
    expect(screen.getByTestId('drawer-probe').props.children).toBe('open');
  });

  it('shares the upcoming lineup', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    renderEvents();
    await screen.findByTestId('event-card-hawaii-2026-10');
    fireEvent.press(screen.getByTestId('events-share'));
    expect(share).toHaveBeenCalledWith({ message: buildEventsShareMessage(FEED.items) });
  });
});

describe('events-screen selectors', () => {
  it('searchEvents matches title, venue and city, case-insensitively', () => {
    expect(searchEvents(FEED.items, 'FAIRPLEX').map((event) => event.id)).toEqual(['pomona-2026-12']);
    expect(searchEvents(FEED.items, 'oahu').map((event) => event.id)).toEqual(['hawaii-2026-10']);
    expect(searchEvents(FEED.items, '  ')).toBe(FEED.items);
  });

  it('buildEventsShareMessage lists only upcoming events', () => {
    expect(buildEventsShareMessage(FEED.items)).toBe(
      [
        'Spotlight Card Show — upcoming events',
        'Spotlight Hawaii · Oct. 24–25 · Oahu, HI',
        'Spotlight Pomona · Dec. 5–6 · Pomona, CA',
        'Spotlight Irvine · Jan. 9 · Irvine, CA',
      ].join('\n'),
    );
    expect(buildEventsShareMessage([pastFeatured])).toBe('Spotlight Card Show — upcoming events');
  });
});
