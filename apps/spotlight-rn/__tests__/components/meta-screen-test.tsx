import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { MetaExposure, MetaExposureQuery, MetaPulse, MetaPulseQuery } from '@spotlight/api-client';
import { MetaScreen } from '@/features/meta-feed/screens/meta-screen';

import { mockMetaExposure, mockMetaPulse } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

function renderMeta(
  fetchMetaPulse: (query?: MetaPulseQuery) => Promise<MetaPulse | null>,
  fetchMetaExposure: (query?: MetaExposureQuery) => Promise<MetaExposure | null> = async () => mockMetaExposure,
) {
  const onBack = jest.fn();
  const onOpenGroup = jest.fn();
  renderWithProviders(<MetaScreen onBack={onBack} onOpenGroup={onOpenGroup} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchMetaExposure, fetchMetaPulse }),
  });
  return { onBack, onOpenGroup };
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

  it("renders this week's read with two value tiles only", async () => {
    renderMeta(async () => mockMetaPulse);

    expect(await screen.findByText(mockMetaPulse.headline.title)).toBeTruthy();
    expect(screen.getByText("This week's read")).toBeTruthy();
    expect(screen.getByTestId('meta-stat-graded')).toBeTruthy();
    expect(screen.getByTestId('meta-stat-raw')).toBeTruthy();
    expect(screen.getByText('+6.8%')).toBeTruthy();
    expect(screen.getByText('+1.2%')).toBeTruthy();
    // No rising/cooling tile, no "written from" line, no groups table or ladder.
    expect(screen.queryByTestId('meta-stat-groups')).toBeNull();
    expect(screen.queryByText(/Written from/)).toBeNull();
    expect(screen.queryByTestId('meta-groups')).toBeNull();
    expect(screen.queryByText('Vintage: raw vs graded')).toBeNull();
  });

  it('lists every riser and cooler as bar rows, with the callout, and opens the group page', async () => {
    const { onBack, onOpenGroup } = renderMeta(async () => mockMetaPulse);
    await screen.findByTestId('meta-content');

    expect(await screen.findByTestId('meta-callout')).toBeTruthy();
    expect(screen.getAllByTestId(/^meta-up-row-[^-]+$/)).toHaveLength(5);
    expect(screen.getAllByTestId(/^meta-down-row-[^-]+$/)).toHaveLength(3);
    expect(screen.getByText('You own 11')).toBeTruthy();

    fireEvent.press(screen.getByTestId('meta-up-row-vintage:raw:nm'));
    expect(onOpenGroup).toHaveBeenCalledWith({
      game: 'pokemon',
      groupKey: 'vintage:raw:nm',
      lane: 'all',
      windowDays: 7,
    });

    fireEvent.press(screen.getByTestId('meta-header-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('hides the callout when signed out', async () => {
    renderMeta(async () => mockMetaPulse, async () => null);
    await screen.findByTestId('meta-content');
    expect(screen.queryByTestId('meta-callout')).toBeNull();
    expect(screen.queryByText(/^You own/)).toBeNull();
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
    const fetchMetaExposure = jest.fn(async () => mockMetaExposure);
    renderMeta(fetchMetaPulse, fetchMetaExposure);
    await screen.findByTestId('meta-content');
    expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'pokemon', lane: 'all', windowDays: 7 });
    expect(fetchMetaExposure).toHaveBeenLastCalledWith({ game: 'pokemon', windowDays: 7 });

    fireEvent.press(screen.getByTestId('meta-lane-raw'));
    await waitFor(() =>
      expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'pokemon', lane: 'raw', windowDays: 7 }),
    );

    fireEvent.press(screen.getByTestId('meta-window-30'));
    await waitFor(() =>
      expect(fetchMetaPulse).toHaveBeenLastCalledWith({ game: 'pokemon', lane: 'raw', windowDays: 30 }),
    );
    await screen.findByText("This month's read");
    await waitFor(() => expect(fetchMetaExposure).toHaveBeenLastCalledWith({ game: 'pokemon', windowDays: 30 }));

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
