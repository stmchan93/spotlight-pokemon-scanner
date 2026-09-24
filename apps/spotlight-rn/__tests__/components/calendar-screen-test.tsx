import { fireEvent, screen } from '@testing-library/react-native';

import type { CalendarFeed, CalendarQuery } from '@spotlight/api-client';
import { CalendarScreen, groupCalendarByMonth } from '@/features/meta-feed/screens/calendar-screen';
import { openCalendarEvent } from '@/features/meta-feed/hooks/use-meta-feed-navigation';

import { mockCalendarFeed } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

function renderCalendar(fetchCalendar: (query?: CalendarQuery) => Promise<CalendarFeed | null>) {
  const onBack = jest.fn();
  const onOpenEvent = jest.fn();
  renderWithProviders(<CalendarScreen onBack={onBack} onOpenEvent={onOpenEvent} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchCalendar }),
  });
  return { onBack, onOpenEvent };
}

describe('CalendarScreen', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('groups upcoming dates by month with kind chips and subtitles', async () => {
    const fetchCalendar = jest.fn(async () => mockCalendarFeed);
    const { onBack, onOpenEvent } = renderCalendar(fetchCalendar);

    expect(await screen.findByTestId('calendar-content')).toBeTruthy();
    expect(fetchCalendar).toHaveBeenCalledWith({ limit: 50 });
    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(screen.getByText('Dates that move prices')).toBeTruthy();
    expect(screen.getByText('SEPTEMBER 2026')).toBeTruthy();
    expect(screen.getByText('OCTOBER 2026')).toBeTruthy();
    expect(screen.getByText('Release')).toBeTruthy();
    expect(screen.getByText('Ban list')).toBeTruthy();
    expect(screen.getByText('Reveal')).toBeTruthy();
    expect(screen.getByText('Event')).toBeTruthy();
    expect(screen.getByText('Set reveals often move older reprint candidates')).toBeTruthy();

    fireEvent.press(screen.getByTestId('calendar-event-release-cel25-anniversary'));
    expect(onOpenEvent).toHaveBeenCalledWith(mockCalendarFeed.items[3]);
    fireEvent.press(screen.getByTestId('calendar-header-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows empty, disabled and error states', async () => {
    renderCalendar(async () => ({ items: [] }));
    expect(await screen.findByTestId('calendar-empty')).toBeTruthy();
  });

  it('says coming soon when the calendar is switched off', async () => {
    renderCalendar(async () => null);
    expect(await screen.findByTestId('calendar-disabled')).toBeTruthy();
  });

  it('offers a retry when the read fails', async () => {
    renderCalendar(async () => {
      throw new Error('offline');
    });
    expect(await screen.findByTestId('calendar-retry')).toBeTruthy();
  });

  it('groups consecutive events by month', () => {
    expect(groupCalendarByMonth(mockCalendarFeed.items).map((month) => [month.key, month.events.length])).toEqual([
      ['2026-09', 2],
      ['2026-10', 2],
    ]);
  });
});

describe('openCalendarEvent', () => {
  it('opens the set page for a set, else the source link, else nothing', () => {
    const openSet = jest.fn();
    const openLink = jest.fn();
    const [release, , , withSet] = mockCalendarFeed.items;

    expect(openCalendarEvent(withSet, openSet, openLink)).toBe(true);
    expect(openSet).toHaveBeenCalledWith('cel25');
    expect(openCalendarEvent(release, openSet, openLink)).toBe(true);
    expect(openLink).toHaveBeenCalledWith('https://www.pokemon.com/us/pokemon-tcg');
    expect(openCalendarEvent({ ...release, setId: null, url: null }, openSet, openLink)).toBe(false);
  });
});
