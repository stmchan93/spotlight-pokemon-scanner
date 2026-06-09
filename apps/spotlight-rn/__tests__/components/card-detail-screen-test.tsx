import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import type { CardDetailRecord, CardText, InventoryCardEntry } from '@spotlight/api-client';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import {
  clearCardDetailPreviewSessions,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  clearScanCandidateReviewSessions,
  saveScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';

import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

const sampleCardText: CardText = {
  number: '001/096',
  rarity: 'Illustration Rare',
  types: ['Grass'],
  hp: '160',
  stage: 'Stage 2',
  abilities: [],
  attacks: [{ name: 'Lunge Out', cost: ['Grass', 'Colorless'], damage: '120', text: null }],
  weaknesses: [{ type: 'Fire', value: '×2' }],
  resistances: [],
  retreatCost: ['Colorless'],
};

describe('CardDetailScreen', () => {
  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearScanCandidateReviewSessions();
    jest.clearAllMocks();
  });

  it('renders the new layout: header, hero, identity, action buttons, configurator, price trend', async () => {
    const onBack = jest.fn();
    const onOpenAddToCollection = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={onBack}
        onOpenAddToCollection={onOpenAddToCollection}
      />,
    );

    // Header title + identity name both render the card name.
    expect(await screen.findByTestId('detail-name')).toBeTruthy();
    expect(screen.getByTestId('detail-header-title').props.children).toBe('Treecko');
    expect(screen.getByTestId('detail-name').props.children).toBe('Treecko');
    expect(screen.getByTestId('detail-back')).toBeTruthy();
    expect(screen.getByTestId('detail-share')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-card')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-card-favorite')).toBeTruthy();

    // Action buttons.
    expect(screen.getByTestId('detail-sell-now')).toBeTruthy();
    expect(screen.getByTestId('detail-add-item')).toBeTruthy();

    // Configurator (variant + grader rows + grade trigger + quantity).
    expect(screen.getByTestId('detail-configurator')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-grader-Raw')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-grader-PSA')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-grade-trigger')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-quantity-value').props.children).toBe(1);

    // Price trend rows (raw lane → per-condition).
    await waitFor(() => {
      expect(screen.getByTestId('detail-price-trends')).toBeTruthy();
    });

    // The old chart / recent-sales / tcg link blocks are gone.
    expect(screen.queryByTestId('detail-history-chart')).toBeNull();
    expect(screen.queryByTestId('detail-tcg-icon')).toBeNull();
    expect(screen.queryByTestId('detail-timeframe-dropdown')).toBeNull();
    expect(screen.queryByTestId('detail-condition-dropdown')).toBeNull();
    expect(screen.queryByText('Recent Sales')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shares the card via the Share API from the header share button', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByTestId('detail-share')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-share'));

    expect(shareSpy).toHaveBeenCalledTimes(1);
    const arg = shareSpy.mock.calls[0][0] as { message?: string; url?: string };
    expect(arg.message).toContain('Treecko');
    expect(typeof arg.url).toBe('string');

    shareSpy.mockRestore();
  });

  it('SELL NOW opens the transaction logger with the card label', async () => {
    const onOpenTransaction = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenTransaction={onOpenTransaction}
      />,
    );

    fireEvent.press(await screen.findByTestId('detail-sell-now'));
    expect(onOpenTransaction).toHaveBeenCalledTimes(1);
    expect(onOpenTransaction.mock.calls[0][0]).toContain('Treecko');
  });

  it('ADD ITEM creates a raw inventory entry with the configured selection and refreshes', async () => {
    const createInventoryEntry = jest.fn(async () => ({
      deckEntryID: 'new-entry',
      cardID: 'sm7-1',
      addedAt: '2026-06-04T00:00:00.000Z',
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ createInventoryEntry }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-add-item'));

    await waitFor(() => {
      expect(createInventoryEntry).toHaveBeenCalledWith(expect.objectContaining({
        cardID: 'sm7-1',
        slabContext: null,
        condition: 'near_mint',
        quantity: 1,
      }));
    });
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'card_detail_add_item_succeeded',
      expect.objectContaining({ kind: 'raw' }),
    );
  });

  it('ADD ITEM builds a graded slabContext when a non-Raw grader is selected', async () => {
    const createInventoryEntry = jest.fn(async () => ({
      deckEntryID: 'new-graded-entry',
      cardID: 'sm7-1',
      addedAt: '2026-06-04T00:00:00.000Z',
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ createInventoryEntry }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(screen.getByTestId('detail-add-item'));

    await waitFor(() => {
      expect(createInventoryEntry).toHaveBeenCalledWith(expect.objectContaining({
        cardID: 'sm7-1',
        condition: null,
        slabContext: expect.objectContaining({ grader: 'PSA', grade: '10' }),
      }));
    });
  });

  it('opens the grade/condition picker and selects a new condition for the raw lane', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grade-trigger'));
    fireEvent.press(await screen.findByTestId('detail-grade-sheet-option-lightly_played'));

    // Selecting closes the sheet, so the option unmounts.
    await waitFor(() => {
      expect(screen.queryByTestId('detail-grade-sheet-option-lightly_played')).toBeNull();
    });
  });

  it('switches the grade picker to numeric grades when a graded grader is selected', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-BGS'));
    fireEvent.press(screen.getByTestId('detail-configurator-grade-trigger'));

    expect(await screen.findByTestId('detail-grade-sheet-option-10')).toBeTruthy();
    expect(screen.getByTestId('detail-grade-sheet-option-9.5')).toBeTruthy();
    expect(screen.queryByTestId('detail-grade-sheet-option-near_mint')).toBeNull();
  });

  it('refetches price trends when the grader lens changes to graded', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: [
        {
          label: query.mode === 'graded' ? 'PSA 10' : 'Near Mint',
          key: query.mode === 'graded' ? 'PSA 10' : 'near_mint',
          currentPrice: 1,
          currencyCode: 'USD',
          points: [1, 2, 3],
          trendPct: 5,
        },
      ],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }),
      },
    );

    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        mode: 'raw',
      }));
    });

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));

    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenLastCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        mode: 'graded',
        grader: 'PSA',
      }));
    });
  });

  it('renders Product Details when the card detail includes cardText', async () => {
    const baseRepository = createTestSpotlightRepository();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, cardText: sampleCardText } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    expect(await screen.findByTestId('detail-product-details')).toBeTruthy();
    expect(screen.getByText('Product Details')).toBeTruthy();
  });

  it('omits Product Details when the card detail has no cardText', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByTestId('detail-name')).toBeTruthy();
    expect(screen.queryByTestId('detail-product-details')).toBeNull();
  });

  it('toggles favorite via the hero heart, persisting via setCardFavorite', async () => {
    let nextIsFavorite = false;
    const setCardFavorite = jest.fn(async (_cardId: string, isFavorite?: boolean | null) => {
      nextIsFavorite = isFavorite ?? !nextIsFavorite;
      return {
        cardId: 'sm7-1',
        favoritedAt: nextIsFavorite ? '2026-05-15T00:00:00.000Z' : null,
        isFavorite: nextIsFavorite,
      };
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ setCardFavorite }),
      },
    );

    const heart = await screen.findByTestId('detail-hero-card-favorite');
    expect(heart.props.accessibilityLabel).toBe('Add to favorites');

    fireEvent.press(heart);
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenLastCalledWith('sm7-1', true);
      expect(screen.getByTestId('detail-hero-card-favorite').props.accessibilityLabel)
        .toBe('Remove from favorites');
    });

    fireEvent.press(screen.getByTestId('detail-hero-card-favorite'));
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenLastCalledWith('sm7-1', false);
      expect(screen.getByTestId('detail-hero-card-favorite').props.accessibilityLabel)
        .toBe('Add to favorites');
    });
  });

  it('defaults the grader to the owned slab grader for a graded entry', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-treecko-psa10',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: { certNumber: '00012345', grade: '10', grader: 'PSA', variantName: 'PSA 10' },
      variantName: 'PSA 10',
    };

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-treecko-psa10"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    // The grade trigger surfaces the owned slab grade for the PSA lane.
    expect(await screen.findByText('PSA 10')).toBeTruthy();
  });

  it('no longer renders the similar-cards button even with scan candidates present', async () => {
    const scanReviewId = saveScanCandidateReviewSession({
      id: 'scan-review-oshawott',
      selectedCardId: 'mcdonalds25-21',
      normalizedImageDimensions: { height: 880, width: 630 },
      normalizedImageUri: 'file:///tmp/normalized-scan.jpg',
      candidates: [
        {
          id: 'mcdonalds25-21-candidate',
          cardId: 'mcdonalds25-21',
          name: 'Oshawott',
          cardNumber: '#21/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          marketPrice: 0.56,
          currencyCode: 'USD',
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `similar-${index}`,
          cardId: `similar-${index}`,
          name: `Similar Card ${index + 1}`,
          cardNumber: `#${index + 1}/99`,
          setName: 'Candidate Set',
          imageUrl: `https://cdn.spotlight.test/similar-${index}.png`,
          marketPrice: index + 1,
          currencyCode: 'USD',
        })),
      ],
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="mcdonalds25-21"
        entryId="entry-2"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        scanReviewId={scanReviewId}
      />,
    );

    // The action buttons still render, but the "N similar" button is gone.
    expect(await screen.findByTestId('detail-sell-now')).toBeTruthy();
    expect(screen.getByTestId('detail-add-item')).toBeTruthy();
    expect(screen.queryByTestId('detail-similar-cards-button')).toBeNull();
    expect(screen.queryByText('9 similar')).toBeNull();
  });

  it('renders the variant selector for a multi-variant card and refetches trends on chip switch', async () => {
    const getCardPriceTrends = jest.fn(async (query: { variant?: string | null }) => ({
      mode: 'raw' as const,
      provider: 'tcgplayer' as const,
      rows: [
        {
          label: query.variant ?? 'Near Mint',
          key: 'near_mint',
          currentPrice: 1,
          currencyCode: 'USD',
          points: [1, 2, 3],
          trendPct: 5,
        },
      ],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }),
      },
    );

    // The selector renders above the trend with a chip per variant option.
    expect(await screen.findByTestId('detail-variant-selector')).toBeTruthy();
    expect(screen.getByTestId('detail-variant-chip-normal')).toBeTruthy();
    expect(screen.getByTestId('detail-variant-chip-raw')).toBeTruthy();

    // Initial fetch uses the seeded first variant ("Normal").
    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        mode: 'raw',
        variant: 'Normal',
      }));
    });

    // Switching to the "Raw" chip refetches trends with the new variant label.
    fireEvent.press(screen.getByTestId('detail-variant-chip-raw'));

    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenLastCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        mode: 'raw',
        variant: 'Raw',
      }));
    });
  });

  it('seeds the default variant for an owned card opened from a preview (detail resolves after the preview)', async () => {
    // Regression: when a card is opened from the collection, an owned-entry
    // preview makes hasSource true on the first render — before getCardDetail
    // resolves and variantOptions populate. The variant seed must wait for the
    // variant list, otherwise it latches selectedVariant to null and the
    // per-card guard blocks recovery, leaving no chip selected.
    const rawEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'raw-treecko-nm',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 12,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: null,
      variantName: null,
    };
    const previewId = saveCardDetailPreviewFromInventoryEntry(rawEntry);

    const getCardPriceTrends = jest.fn(async (query: { variant?: string | null }) => ({
      mode: 'raw' as const,
      provider: 'tcgplayer' as const,
      rows: [
        {
          label: query.variant ?? 'Near Mint',
          key: 'near_mint',
          currentPrice: 1,
          currencyCode: 'USD',
          points: [1, 2, 3],
          trendPct: 5,
        },
      ],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="raw-treecko-nm"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        previewId={previewId}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }),
      },
    );

    // The "Normal" default is seeded once variantOptions resolve, so its chip is
    // the selected one even though the preview made hasSource true earlier.
    await screen.findByTestId('detail-variant-chip-normal');
    await waitFor(() => {
      expect(
        screen.getByTestId('detail-variant-chip-normal').props.accessibilityState?.selected,
      ).toBe(true);
    });
    expect(
      screen.getByTestId('detail-variant-chip-raw').props.accessibilityState?.selected,
    ).toBe(false);

    // The raw-lane price fetch carries the seeded variant, not a null lens.
    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: 'sm7-1', mode: 'raw', variant: 'Normal' }),
      );
    });
  });

  it('renders an unavailable state when the repository returns no local card detail', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="missing-card-id"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Card unavailable')).toBeTruthy();
    expect(screen.getByText('We could not find this card in the local catalog.')).toBeTruthy();
  });
});
