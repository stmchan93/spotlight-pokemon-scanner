import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { CalendarFeed, MetaGroup, MetaPulse } from '@spotlight/api-client';

import {
  formatReleaseLine,
  formatTrendDate,
  groupYearsLine,
  MarketWatchPage,
} from '@/features/social/screens/market-watch-page';
import type { CollapsiblePageProps } from '@/components/page-tab-pager';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useFocusEffect: (callback: () => void) => {
    require('react').useEffect(callback, [callback]);
  },
  useRouter: () => ({ push: mockPush, navigate: jest.fn(), back: jest.fn() }),
}));

const page: CollapsiblePageProps = {
  contentContainerStyle: { minHeight: 800, paddingTop: 100 },
  onScroll: () => {},
  progressViewOffset: 100,
  scrollEventThrottle: 16,
  scrollToOverflowEnabled: true,
};

function group(overrides: Partial<MetaGroup>): MetaGroup {
  return {
    groupKey: 'ex_era:raw',
    label: 'EX era',
    lane: 'raw',
    description: '2003–2007 · 2,626 cards',
    medianChangePercent: 1.4,
    valueNow: 110,
    valueThen: 100,
    valueChangeUsd: 10,
    cardCount: 100,
    movedCardCount: 10,
    sparkPoints: [100, 101, 102],
    topCards: [],
    ...overrides,
  };
}

function pulse(groups: MetaGroup[]): MetaPulse {
  return {
    game: 'pokemon',
    windowDays: 30,
    lane: 'all',
    availableWindows: [7, 30, 90],
    availableGames: ['pokemon'],
    computedAt: '2026-11-01T00:00:00Z',
    asOfDate: '2026-11-01',
    headline: { title: '', body: '' },
    summary: {
      rawValueChangePercent: null,
      rawValueChangeUsd: null,
      gradedValueChangePercent: null,
      gradedValueChangeUsd: null,
      risingCount: 0,
      coolingCount: 0,
    },
    groups,
    ladders: [],
  };
}

const calendar: CalendarFeed = {
  items: [
    { id: 'rel', date: '2026-11-06', kind: 'release', game: 'pokemon', title: 'Delta Reign', subtitle: null, setId: 'set-1', url: null },
    { id: 'ban', date: '2026-11-07', kind: 'ban_list', game: 'pokemon', title: 'Ban list', subtitle: null, setId: null, url: null },
  ],
};

function renderPage(overrides: Parameters<typeof createTestSpotlightRepository>[0]) {
  const spotlightRepository = createTestSpotlightRepository(overrides);
  renderWithProviders(<MarketWatchPage page={page} />, { spotlightRepository });
  return spotlightRepository;
}

describe('MarketWatchPage', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('formats dates and the group year range', () => {
    expect(formatTrendDate('2026-11-01')).toBe('NOV 1');
    expect(formatReleaseLine('2026-11-06')).toBe('Nov 6 Release');
    expect(groupYearsLine('2003–2007 · 2,626 cards')).toBe('2003–2007');
  });

  it('shows releases only, and risers and coolers under their own headers', async () => {
    renderPage({
      fetchCalendar: async () => calendar,
      fetchMetaPulse: async () =>
        pulse([group({}), group({ groupKey: 'promos:raw', label: 'Promos', medianChangePercent: -1.4 })]),
    });

    expect(await screen.findByTestId('market-watch-page-set-rel')).toBeTruthy();
    expect(screen.queryByTestId('market-watch-page-set-ban')).toBeNull();
    expect(screen.getByText('Nov 6 Release')).toBeTruthy();

    expect(await screen.findByText('TRENDING UP')).toBeTruthy();
    expect(screen.getByText('COOLING OFF')).toBeTruthy();
    expect(screen.getByTestId('market-watch-page-date')).toHaveTextContent('NOV 1');
    expect(screen.getByTestId('market-watch-page-group-ex_era:raw-change')).toHaveTextContent('+1.4%');
    expect(screen.getByTestId('market-watch-page-group-promos:raw-change')).toHaveTextContent('−1.4%');
  });

  it('says when one side has no sets', async () => {
    renderPage({
      fetchCalendar: async () => ({ items: [] }),
      fetchMetaPulse: async () => pulse([group({})]),
    });

    expect(await screen.findByText('TRENDING UP')).toBeTruthy();
    expect(screen.getByText('COOLING OFF')).toBeTruthy();
    expect(screen.getByTestId('market-watch-page-cooling-off-empty').props.children).toBe(
      'No sets cooling this month.',
    );
    expect(screen.queryByTestId('market-watch-page-trending-up-empty')).toBeNull();
    expect(screen.queryByText('UPCOMING SETS')).toBeNull();
  });

  it('opens the group for the selected game and window', async () => {
    renderPage({
      fetchCalendar: async () => ({ items: [] }),
      fetchMetaPulse: async () => pulse([group({})]),
    });

    fireEvent.press(await screen.findByTestId('market-watch-page-group-ex_era:raw'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/meta/group/[groupKey]',
      params: { game: 'pokemon', groupKey: 'ex_era:raw', window: '30' },
    });
  });

  it('reads the chosen game\'s sets with a 30-day window', async () => {
    const fetchMetaPulse = jest.fn(async () => pulse([group({})]));
    renderPage({ fetchCalendar: async () => ({ items: [] }), fetchMetaPulse });

    fireEvent.press(await screen.findByTestId('market-watch-page-games-onepiece'));

    await waitFor(() =>
      expect(fetchMetaPulse).toHaveBeenCalledWith({ game: 'onepiece', windowDays: 30, kind: 'sets' }),
    );
  });

  it('says so when there is nothing to show', async () => {
    renderPage({ fetchCalendar: async () => null, fetchMetaPulse: async () => null });

    expect(await screen.findByTestId('market-watch-page-empty')).toBeTruthy();
  });
});
