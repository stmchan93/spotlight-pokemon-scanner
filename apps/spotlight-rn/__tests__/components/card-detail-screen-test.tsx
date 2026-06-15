import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking, Share } from 'react-native';

import type { CardDetailRecord, CardText, InventoryCardEntry } from '@spotlight/api-client';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import {
  clearCardDetailPreviewSessions,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  clearCardDetailCache,
  prefetchCardDetail,
} from '@/features/cards/card-detail-prefetch';
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
    clearCardDetailCache();
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
    // The grade sheet animates open; allow extra time so this stays green under
    // full-suite load (not just when the file runs in isolation).
    fireEvent.press(
      await screen.findByTestId('detail-grade-sheet-option-lightly_played', {}, { timeout: 5000 }),
    );

    // Selecting closes the sheet, so the option unmounts.
    await waitFor(() => {
      expect(screen.queryByTestId('detail-grade-sheet-option-lightly_played')).toBeNull();
    }, { timeout: 5000 });
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

  // The backend emits two row-key shapes depending on version: the staging shape
  // (graded "PSA 10", raw "NM") and the pipe shape (graded "PSA|10|<variant>", raw
  // "<variant>|NM"). The deep-link handler must parse BOTH.
  const trendRows = (mode: string, pipeKeys = false) => ([
    {
      label: mode === 'graded' ? 'PSA 10' : 'Near Mint',
      key: mode === 'graded'
        ? (pipeKeys ? 'PSA|10|' : 'PSA 10')
        : (pipeKeys ? 'normal|near_mint' : 'NM'),
      currentPrice: 100,
      currencyCode: 'USD',
      points: [1, 2, 3],
      trendPct: 2,
    },
  ]);

  it('raw price-trend row deep-links to the card on TCGplayer with the condition filter (no printing)', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} onOpenAddToCollection={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    fireEvent.press(await screen.findByTestId('detail-price-trends-row-NM'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    const url = openURL.mock.calls[0][0] as string;
    expect(url).toContain('tcgplayer.com/search');
    expect(url.toLowerCase()).toContain('treecko');
    // Keep the helpful condition filter…
    expect(url).toContain('Condition=Near+Mint');
    // …but never the Printing facet (it over-constrains promos → wrong card).
    expect(url).not.toContain('Printing=');
  });

  it('graded price-trend row opens eBay sold-listings search scoped to the grade', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} onOpenAddToCollection={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    const url = openURL.mock.calls[0][0] as string;
    expect(url).toContain('https://www.ebay.com/sch/i.html');
    expect(url).toContain('_nkw=PSA+10'); // grader + grade lead the sold-search query
    expect(url).toContain('LH_Sold=1');
    expect(url).toContain('LH_Complete=1');
  });

  it('parses the pipe-delimited graded row key too (backend version robustness)', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode, true),
    }));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} onOpenAddToCollection={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA|10|'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    // The pipe key "PSA|10|<variant>" still yields grader=PSA, grade=10 in the query.
    expect(openURL.mock.calls[0][0] as string).toContain('_nkw=PSA+10');
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

    // The configurator renders a single "Variant" chip row (one chip per option).
    expect(await screen.findByTestId('detail-configurator')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-variant-normal')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-variant-raw')).toBeTruthy();

    // Initial fetch uses the seeded first variant ("Normal").
    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        mode: 'raw',
        variant: 'Normal',
      }));
    });

    // Switching to the "Raw" chip refetches trends with the new variant label.
    fireEvent.press(screen.getByTestId('detail-configurator-variant-raw'));

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
    await screen.findByTestId('detail-configurator-variant-normal');
    await waitFor(() => {
      expect(
        screen.getByTestId('detail-configurator-variant-normal').props.accessibilityState?.selected,
      ).toBe(true);
    });
    expect(
      screen.getByTestId('detail-configurator-variant-raw').props.accessibilityState?.selected,
    ).toBe(false);

    // The raw-lane price fetch carries the seeded variant, not a null lens.
    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: 'sm7-1', mode: 'raw', variant: 'Normal' }),
      );
    });
  });

  it('fires the price-trends request on mount (from the preview default lane) without waiting for variant seeding', async () => {
    // A graded owned-entry preview is available on the first render, before
    // getCardDetail resolves and variantOptions/seeding settle. The early
    // parallel fetch must hit the trends endpoint immediately on the graded
    // default lane — proving it is NOT serialized behind variant seeding.
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
    const previewId = saveCardDetailPreviewFromInventoryEntry(gradedEntry);

    // getCardDetail never resolves: if the trends fetch were serialized behind
    // detail + seeding, it would never fire. The early parallel fetch ignores it.
    const getCardDetail = jest.fn(() => new Promise<never>(() => {}));
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: 'ebay' as const,
      rows: [
        {
          label: 'PSA 10',
          key: 'PSA 10',
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
        entryId="graded-treecko-psa10"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        previewId={previewId}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ getCardDetail, getCardPriceTrends }),
      },
    );

    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        mode: 'graded',
        grader: 'PSA',
      }));
    });
  });

  it('shows the price-trend skeleton while the trends fetch is in flight, then the list', async () => {
    type TrendList = Awaited<
      ReturnType<ReturnType<typeof createTestSpotlightRepository>['getCardPriceTrends']>
    >;
    let resolveTrends: ((value: TrendList) => void) | null = null;
    const getCardPriceTrends = jest.fn(
      () =>
        new Promise<TrendList>((resolve) => {
          resolveTrends = resolve;
        }),
    );

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} onOpenAddToCollection={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    // While the fetch is pending the skeleton stands in for the list.
    expect(await screen.findByTestId('detail-price-trends-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('detail-price-trends')).toBeNull();

    const resolve = resolveTrends as ((value: TrendList) => void) | null;
    await act(async () => {
      resolve?.({
        mode: 'raw',
        provider: 'tcgplayer',
        rows: [
          {
            label: 'Near Mint',
            key: 'near_mint',
            currentPrice: 1,
            currencyCode: 'USD',
            points: [1, 2, 3],
            trendPct: 5,
          },
        ],
      });
    });

    // Once data lands the list replaces the skeleton.
    await waitFor(() => {
      expect(screen.getByTestId('detail-price-trends')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-price-trends-skeleton')).toBeNull();
  });

  it('renders a prefetched/cached result without issuing a second trends request', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: 'tcgplayer' as const,
      rows: [
        {
          label: 'Near Mint',
          key: 'near_mint',
          currentPrice: 1,
          currencyCode: 'USD',
          points: [1, 2, 3],
          trendPct: 5,
        },
      ],
    }));
    const repository = createTestSpotlightRepository({ getCardPriceTrends });

    // Simulate a navigation prefetch warming the default raw lane cache.
    prefetchCardDetail(repository, 'sm7-1');
    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledTimes(1);
    });
    const callsAfterPrefetch = getCardPriceTrends.mock.calls.length;

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} onOpenAddToCollection={jest.fn()} />,
      { spotlightRepository: repository },
    );

    // The screen reads through the cache → the trend list renders…
    await waitFor(() => {
      expect(screen.getByTestId('detail-price-trends')).toBeTruthy();
    });
    // …and the default raw/Normal lane was NOT re-requested over the network.
    expect(getCardPriceTrends).toHaveBeenCalledTimes(callsAfterPrefetch);
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
