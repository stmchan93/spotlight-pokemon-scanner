import { act, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { mockHotCards } from '@spotlight/api-client';

import { metaFeedCacheKey, useHotCards } from '@/features/meta-feed/hooks/use-meta-feed';
import type { UseMetaFeedReadResult } from '@/features/meta-feed/hooks/use-meta-feed-read';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

let latest: UseMetaFeedReadResult<typeof mockHotCards> | null = null;

function Probe() {
  const result = useHotCards();
  latest = result;
  return <Text testID="probe">{result.data ? result.data.items.length : 'none'}</Text>;
}

describe('meta feed hooks', () => {
  beforeEach(() => {
    latest = null;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keys the cache on the query, ignoring empty fields', () => {
    expect(metaFeedCacheKey('newsFeed', undefined)).toBe('newsFeed');
    expect(metaFeedCacheKey('newsFeed', { game: null, limit: 3 })).toBe('newsFeed?limit=3');
    expect(metaFeedCacheKey('metaPulse', { windowDays: 30, game: 'pokemon' }))
      .toBe('metaPulse?game=pokemon&windowDays=30');
  });

  it('keeps the last good payload when a refresh fails', async () => {
    const fetchHotCards = jest.fn()
      .mockResolvedValueOnce(mockHotCards)
      .mockRejectedValueOnce(new Error('down'));
    renderWithProviders(<Probe />, {
      spotlightRepository: createTestSpotlightRepository({ fetchHotCards }),
    });

    await waitFor(() => expect(screen.getByTestId('probe').props.children).toBe(3));
    await act(async () => {
      await latest?.refresh();
    });
    expect(fetchHotCards).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('probe').props.children).toBe(3);
  });

  it('hides on a disabled read (null)', async () => {
    const fetchHotCards = jest.fn().mockResolvedValue(null);
    renderWithProviders(<Probe />, {
      spotlightRepository: createTestSpotlightRepository({ fetchHotCards }),
    });

    await waitFor(() => expect(fetchHotCards).toHaveBeenCalled());
    expect(screen.getByTestId('probe').props.children).toBe('none');
  });
});
