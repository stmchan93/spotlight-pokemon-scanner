import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import type { SimilarCard, SimilarCards } from '@spotlight/api-client';

import { CardSimilarSection } from '@/features/cards/components/card-similar-section';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { clearCardDetailPreviewSessions } from '@/features/cards/card-detail-preview-session';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function card(cardId: string, name: string, overrides: Partial<SimilarCard> = {}): SimilarCard {
  return {
    cardId,
    name,
    setName: 'Deoxys',
    number: '105/107',
    language: 'English',
    imageUrl: `https://img/${cardId}.png`,
    priceNow: 1700,
    currencyCode: 'USD',
    ...overrides,
  };
}

const FULL: SimilarCards = {
  cardId: 'ex8-106',
  baseName: 'Latios',
  goesWith: card('ex8-105', 'Latias ☆'),
  sameName: [
    card('pcg2_ja-66', 'Latios ☆', { language: 'Japanese', setName: 'Clash of the Blue Sky', priceNow: 1150 }),
    card('ex3-94', 'Latios ex', { priceNow: null }),
  ],
  sameLookCheaper: [card('sv8-1', 'Latias ex', { setName: 'Dragon', priceNow: 165 })],
};

const EMPTY: SimilarCards = { cardId: 'ex8-106', baseName: null, goesWith: null, sameName: [], sameLookCheaper: [] };

function renderSection(
  fetchSimilarCards: (cardId: string) => Promise<SimilarCards | null>,
  { enabled = true, onPressCard = jest.fn() }: { enabled?: boolean; onPressCard?: jest.Mock } = {},
) {
  const repository = { fetchSimilarCards: jest.fn(fetchSimilarCards) };
  const utils = render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <CardSimilarSection
          cardId="ex8-106"
          enabled={enabled}
          onPressCard={onPressCard}
          repository={repository}
          testID="similar"
        />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
  return { ...utils, repository, onPressCard };
}

describe('CardSimilarSection', () => {
  it('renders the three rows with titles, sub lines and prices', async () => {
    renderSection(async () => FULL);

    expect(await screen.findByText('More like this')).toBeTruthy();
    expect(screen.getByTestId('similar-goes-with')).toBeTruthy();
    expect(screen.getByText('Goes with')).toBeTruthy();
    expect(screen.getByText('Complete the pair')).toBeTruthy();
    expect(screen.getByText('Other Latios cards')).toBeTruthy();
    expect(screen.getByText('Same look, lower price')).toBeTruthy();
    expect(screen.getByText('Japanese · Clash of the Blue Sky · 105/107')).toBeTruthy();
    expect(screen.getByTestId('similar-cheaper-sv8-1-price').props.children).toBe('$165.00');
    // Unpriced tiles simply drop the price line.
    expect(screen.queryByTestId('similar-same-name-ex3-94-price')).toBeNull();
  });

  it('hides empty rows individually', async () => {
    renderSection(async () => ({ ...FULL, goesWith: null, sameLookCheaper: [] }));

    expect(await screen.findByTestId('similar-same-name')).toBeTruthy();
    expect(screen.queryByTestId('similar-goes-with')).toBeNull();
    expect(screen.queryByTestId('similar-cheaper')).toBeNull();
  });

  it('hides the whole section when every row is empty, disabled (null) or failing', async () => {
    for (const fetcher of [
      async () => EMPTY,
      async () => null,
      async () => {
        throw new Error('boom');
      },
    ]) {
      const { repository, unmount } = renderSection(fetcher);
      await waitFor(() => expect(repository.fetchSimilarCards).toHaveBeenCalledWith('ex8-106'));
      // Let the fetch settle so a wrongly rendered section would be visible.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId('similar')).toBeNull();
      expect(screen.queryByText('More like this')).toBeNull();
      unmount();
    }
  });

  it('does not fetch until enabled (after the main card payload)', () => {
    const { repository } = renderSection(async () => FULL, { enabled: false });
    expect(repository.fetchSimilarCards).not.toHaveBeenCalled();
  });

  it('reports the tapped card', async () => {
    const { onPressCard } = renderSection(async () => FULL);

    fireEvent.press(await screen.findByTestId('similar-goes-with-ex8-105'));
    fireEvent.press(screen.getByTestId('similar-cheaper-sv8-1'));

    expect(onPressCard).toHaveBeenNthCalledWith(1, expect.objectContaining({ cardId: 'ex8-105' }));
    expect(onPressCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ cardId: 'sv8-1' }));
  });
});

describe('CardDetailScreen "More like this"', () => {
  const push = jest.fn();

  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({ push, replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() });
  });

  afterEach(() => {
    clearCardDetailCache();
    clearCardDetailPreviewSessions();
    jest.clearAllMocks();
  });

  it('loads after the card detail and pushes the tapped card PDP', async () => {
    const fetchSimilarCards = jest.fn(async (cardId: string) => ({ ...FULL, cardId }));
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ fetchSimilarCards }),
    });

    fireEvent.press(await screen.findByTestId('detail-similar-cheaper-sv8-1'));

    expect(fetchSimilarCards).toHaveBeenCalledWith('sm7-1');
    expect(push).toHaveBeenCalledWith({
      pathname: '/cards/[cardId]',
      params: expect.objectContaining({ cardId: 'sv8-1', previewId: expect.any(String) }),
    });
  });
});
