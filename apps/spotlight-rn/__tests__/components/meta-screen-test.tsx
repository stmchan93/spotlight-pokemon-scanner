import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { MetaPulse, MetaPulseQuery } from '@spotlight/api-client';
import { MetaScreen } from '@/features/meta-feed/screens/meta-screen';

import { mockMetaPulse } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

function renderMeta(fetchMetaPulse: (query?: MetaPulseQuery) => Promise<MetaPulse | null>) {
  const onBack = jest.fn();
  const onOpenCard = jest.fn();
  renderWithProviders(<MetaScreen onBack={onBack} onOpenCard={onOpenCard} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchMetaPulse }),
  });
  return { onBack, onOpenCard };
}

describe('MetaScreen', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a skeleton while the first read is in flight', () => {
    renderMeta(() => new Promise(() => {}));
    expect(screen.getByTestId('meta-loading')).toBeTruthy();
    expect(screen.getByText('Meta')).toBeTruthy();
  });

  it('renders the headline, groups table, ladder and driving cards', async () => {
    const { onBack, onOpenCard } = renderMeta(async () => mockMetaPulse);

    expect(await screen.findByText(mockMetaPulse.headline.title)).toBeTruthy();
    expect(screen.getByText("This week's read")).toBeTruthy();
    expect(screen.getByText('+6.8%')).toBeTruthy();
    expect(screen.getAllByText('+$412k')).toHaveLength(2);
    expect(screen.getByText('4 ▲ 2 ▼')).toBeTruthy();

    // Groups: median pill, value change and card count per row.
    expect(screen.getByTestId('meta-group-vintage:graded:psa10:pop_le_50')).toBeTruthy();
    expect(screen.getAllByText('+18.4%').length).toBeGreaterThan(0);
    expect(screen.getByText('−$188k')).toBeTruthy();
    expect(screen.getByText('9,600')).toBeTruthy();
    expect(screen.getByText(/one odd sale can't swing it/)).toBeTruthy();

    // Ladder with its window caption.
    expect(screen.getByText('Vintage: raw vs graded')).toBeTruthy();
    expect(screen.getByText('past 7 days')).toBeTruthy();

    // Cards driving the top group; tapping opens the card.
    expect(screen.getByText('Cards driving Vintage PSA 10 · pop ≤ 50')).toBeTruthy();
    fireEvent.press(screen.getByTestId('meta-driving-card-ecard3-149'));
    expect(onOpenCard).toHaveBeenCalledWith('ecard3-149');

    fireEvent.press(screen.getByTestId('meta-header-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('switches the driving list when another group is tapped', async () => {
    renderMeta(async () => mockMetaPulse);
    await screen.findByTestId('meta-driving');

    // The raw vintage group has no top cards, so the section drops out.
    fireEvent.press(screen.getByTestId('meta-group-vintage:raw:nm'));
    expect(screen.queryByTestId('meta-driving')).toBeNull();
  });

  it('disables windows the server has no history for', async () => {
    renderMeta(async () => mockMetaPulse);
    await screen.findByTestId('meta-content');

    expect(screen.getByTestId('meta-window-90').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(screen.getByTestId('meta-window-30').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
  });

  it('refetches with the new query on every filter change', async () => {
    const fetchMetaPulse = jest.fn(async (query?: MetaPulseQuery) => ({
      ...mockMetaPulse,
      game: query?.game ?? 'pokemon',
      lane: query?.lane ?? 'all',
      windowDays: query?.windowDays ?? 7,
    }));
    renderMeta(fetchMetaPulse);
    await screen.findByTestId('meta-content');
    expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'pokemon', lane: 'all', windowDays: 7 });

    fireEvent.press(screen.getByTestId('meta-lane-raw'));
    await waitFor(() =>
      expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'pokemon', lane: 'raw', windowDays: 7 }),
    );

    fireEvent.press(screen.getByTestId('meta-window-30'));
    await waitFor(() =>
      expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'pokemon', lane: 'raw', windowDays: 30 }),
    );
    await screen.findByText('past 30 days');

    fireEvent.press(screen.getByTestId('meta-game-onepiece'));
    await waitFor(() =>
      expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'onepiece', lane: 'raw', windowDays: 30 }),
    );
  });

  it('shows an empty state when no group moved', async () => {
    renderMeta(async () => ({ ...mockMetaPulse, groups: [], ladders: [] }));
    expect(await screen.findByTestId('meta-empty')).toBeTruthy();
  });

  it('shows a retryable error when the read fails', async () => {
    const fetchMetaPulse = jest
      .fn<Promise<MetaPulse | null>, [MetaPulseQuery?]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(mockMetaPulse);
    renderMeta(fetchMetaPulse);

    fireEvent.press(await screen.findByTestId('meta-retry'));
    expect(await screen.findByText(mockMetaPulse.headline.title)).toBeTruthy();
    expect(fetchMetaPulse).toHaveBeenCalledTimes(2);
  });

  it('says coming soon when the feature flag is off', async () => {
    renderMeta(async () => null);
    expect(await screen.findByTestId('meta-disabled')).toBeTruthy();
  });
});
