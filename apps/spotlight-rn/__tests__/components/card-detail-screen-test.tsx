import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Keyboard, Linking, StyleSheet, Share } from 'react-native';
import { useRouter } from 'expo-router';

import type { CardDetailRecord, CardText, InventoryCardEntry } from '@spotlight/api-client';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { resetPremiumUnlock } from '@/features/monetization/entitlements';
import { clearCardAddedNotice, consumeCardAddedNotice } from '@/features/cards/card-added-notice';
import {
  clearCardDetailPreviewSessions,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  clearCardDetailCache,
  hasFreshCardDetail,
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

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();

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
  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({
      replace: mockReplace,
      push: jest.fn(),
      back: mockBack,
      dismissTo: mockDismissTo,
    });
  });

  afterEach(() => {
    clearCardAddedNotice();
    clearCardDetailPreviewSessions();
    clearScanCandidateReviewSessions();
    clearCardDetailCache();
    resetPremiumUnlock();
    jest.clearAllMocks();
  });

  it('renders the new layout: header, hero, identity, action buttons, configurator, price trend', async () => {
    const onBack = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={onBack}
      />,
    );

    // Header title + identity name both render the card name.
    expect(await screen.findByTestId('detail-name')).toBeTruthy();
    expect(screen.getByTestId('detail-header-title').props.children).toBe('Treecko');
    expect(screen.getByTestId('detail-name').props.children).toBe('Treecko');
    expect(screen.getByTestId('detail-back')).toBeTruthy();
    expect(screen.getByTestId('detail-share')).toBeTruthy();
    /*
      Delete and share sit in ONE glass pill (Figma 3686:55175), not two
      separate circles that happen to be adjacent — and back sits in the same
      material opposite them, so the bar carries one chrome style rather than
      two. `within` is what pins the GROUPING; asserting both testIDs exist
      would still pass if they drifted back apart.
    */
    const headerActions = screen.getByTestId('detail-header-actions');
    expect(within(headerActions).getByTestId('detail-share')).toBeTruthy();
    expect(screen.getByTestId('detail-back-group')).toBeTruthy();
    expect(
      within(screen.getByTestId('detail-back-group')).getByTestId('detail-back'),
    ).toBeTruthy();
    expect(screen.getByTestId('detail-hero-card')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-card-favorite')).toBeTruthy();

    // Action buttons.
    expect(screen.getByTestId('detail-add-item')).toBeTruthy();

    // Configurator now holds only the variant + grader rows; Grade + Quantity
    // moved into the Add to Collection sheet (Figma 1664:255).
    expect(screen.getByTestId('detail-configurator')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-grader-Raw')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-grader-PSA')).toBeTruthy();
    expect(screen.queryByTestId('detail-configurator-grade-trigger')).toBeNull();
    expect(screen.queryByTestId('detail-configurator-quantity-value')).toBeNull();

    // Tapping ADD ITEM opens the sheet, which hosts Grade + Quantity.
    fireEvent.press(screen.getByTestId('detail-add-item'));
    expect(await screen.findByTestId('detail-add-sheet-grade-trigger')).toBeTruthy();
    expect(screen.getByTestId('detail-add-sheet-quantity-value').props.children).toBe(1);
    // Dismiss the sheet so the rest of the page is interactable again.
    fireEvent.press(screen.getByTestId('detail-add-sheet-backdrop'));

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

  it('shares the card via the bottom SHARE button', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
    );

    fireEvent.press(await screen.findByTestId('detail-share-button'));
    expect(shareSpy).toHaveBeenCalledTimes(1);

    shareSpy.mockRestore();
  });

  it('Add to Collection sheet hosts the full configurator + Condition dropdown, pre-filled from the PDP', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
    );

    fireEvent.press(await screen.findByTestId('detail-add-item'));

    // Variant / Grader chips live in the sheet, pre-filled to the PDP selection
    // (Raw by default). The language row is NOT in the sheet — EN/JP lives on the
    // PDP body and switching navigates to the counterpart card.
    expect(await screen.findByTestId('detail-add-sheet-configurator-grader-Raw')).toBeTruthy();
    expect(screen.getByTestId('detail-add-sheet-configurator-grader-Raw').props.accessibilityState?.selected).toBe(true);
    expect(screen.queryByTestId('detail-add-sheet-configurator-language-EN')).toBeNull();

    // Raw lane → the dropdown is titled "Condition", and Quantity seeds to 1.
    const conditionTrigger = screen.getByTestId('detail-add-sheet-grade-trigger');
    expect(conditionTrigger.props.accessibilityLabel).toContain('Condition');
    expect(screen.getByTestId('detail-add-sheet-quantity-value').props.children).toBe(1);
  });

  it('hides the EN/JP language toggle when the card has no counterpart', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
    );

    // The default mock card has no EN↔JP link, so the language row never renders.
    await screen.findByTestId('detail-configurator');
    expect(screen.queryByTestId('detail-configurator-language-EN')).toBeNull();
    expect(screen.queryByTestId('detail-configurator-language-JP')).toBeNull();
  });

  it('swaps EN→JP in place: new art + trends, grade/grader kept, variant by name, no navigation', async () => {
    const baseRepository = createTestSpotlightRepository();
    // Two linked cards: EN sm7-1 (Treecko) ↔ JP sm7-1-jp (distinct name/art),
    // both carrying the "Normal" variant so it carries over by name.
    const getCardDetail = jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      if (!base) {
        return null;
      }
      if (query.cardId === 'sm7-1-jp') {
        return {
          ...base,
          cardId: 'sm7-1-jp',
          name: 'Treecko (JP)',
          largeImageUrl: 'https://cdn.spotlight.test/sm7/treecko-jp.png',
          language: 'japanese',
          counterpartCardId: 'sm7-1',
          counterpartLanguage: 'english',
        } satisfies CardDetailRecord;
      }
      return {
        ...base,
        language: 'english',
        counterpartCardId: 'sm7-1-jp',
        counterpartLanguage: 'japanese',
      } satisfies CardDetailRecord;
    });
    // Record which card the trends were fetched for.
    const trendCardIds: string[] = [];
    const getCardPriceTrends = jest.fn(async (query: { cardId: string; mode: string }) => {
      trendCardIds.push(query.cardId);
      return {
        mode: query.mode as 'raw' | 'graded',
        provider: 'tcgplayer' as const,
        rows: [
          { label: 'Near Mint', key: 'near_mint', currentPrice: 1, currencyCode: 'USD', points: [1, 2, 3], trendPct: 5 },
        ],
      };
    });

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardDetail, getCardPriceTrends }) },
    );

    // English card shown, EN selected, Normal variant + Raw grader seeded.
    expect((await screen.findByTestId('detail-name')).props.children).toBe('Treecko');
    expect(screen.getByTestId('detail-configurator-language-EN').props.accessibilityState?.selected).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId('detail-configurator-variant-normal').props.accessibilityState?.selected).toBe(true),
    );

    fireEvent.press(screen.getByTestId('detail-configurator-language-JP'));

    // In-place swap: the SAME screen now shows the JP card's name/art…
    await waitFor(() => {
      expect(screen.getByTestId('detail-name').props.children).toBe('Treecko (JP)');
    });
    // …grader stays Raw, the variant carries over by name (Normal), JP chip is selected…
    expect(screen.getByTestId('detail-configurator-grader-Raw').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('detail-configurator-variant-normal').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('detail-configurator-language-JP').props.accessibilityState?.selected).toBe(true);
    // …trends refetched for the JP card (the name swap above already proves the
    // JP detail loaded in place), and NO navigation happened.
    await waitFor(() => expect(trendCardIds).toContain('sm7-1-jp'));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('SAVE after an EN→JP swap retargets the owned entry to the JP printing (no silent no-op)', async () => {
    // Regression: the user owns the EN card only. After swapping the displayed
    // card to the JP counterpart, every cardId-filtered owned pool is empty —
    // selectedEntry used to null out and SAVE silently returned.
    const ownedEnEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'e-owned-en',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 12,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: null,
      variantName: 'Normal',
    };

    const baseRepository = createTestSpotlightRepository();
    const getCardDetail = jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      if (!base) {
        return null;
      }
      if (query.cardId === 'sm7-1-jp') {
        return {
          ...base,
          cardId: 'sm7-1-jp',
          name: 'Treecko (JP)',
          language: 'japanese',
          counterpartCardId: 'sm7-1',
          counterpartLanguage: 'english',
          ownedEntries: [], // the JP printing is NOT owned — the regression condition
        } satisfies CardDetailRecord;
      }
      return {
        ...base,
        language: 'english',
        counterpartCardId: 'sm7-1-jp',
        counterpartLanguage: 'japanese',
        ownedEntries: [ownedEnEntry],
      } satisfies CardDetailRecord;
    });

    const replacePortfolioEntry = jest.fn(async () => ({
      previousDeckEntryID: 'e-owned-en',
      deckEntryID: 'e-owned-en',
      cardID: 'sm7-1-jp',
      quantity: 1,
      unitPrice: null,
      updatedAt: '2026-04-27T12:00:00.000Z',
    }));
    const updateDeckEntryCostBasis = jest.fn(async () => ({
      deckEntryID: 'e-owned-en',
      cardID: 'sm7-1-jp',
      costBasisPerUnit: null,
      costBasisPerUnitCents: null,
      currencyCode: 'USD',
      updatedAt: '2026-04-27T12:00:00.000Z',
    }));
    const onBack = jest.fn();

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" entryId="e-owned-en" onBack={onBack} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail,
          replacePortfolioEntry,
          updateDeckEntryCostBasis,
        }),
      },
    );

    // Owned EN card → edit mode with SAVE visible.
    expect((await screen.findByTestId('detail-name')).props.children).toBe('Treecko');
    await screen.findByTestId('detail-save-edit');

    // Swap to the JP printing and SAVE immediately — WITHOUT waiting for the
    // counterpart detail to load. The toggle sets activeCardId synchronously
    // while `detail` refetches; a fast SAVE used to persist the OLD printing
    // from the stale detail (the "toggled and saved but nothing changed" bug).
    fireEvent.press(screen.getByTestId('detail-configurator-language-JP'));
    fireEvent.press(screen.getByTestId('detail-save-edit'));

    // SAVE must actually save: replace the pinned entry with the JP cardID.
    await waitFor(() => {
      expect(replacePortfolioEntry).toHaveBeenCalledWith(
        expect.objectContaining({ deckEntryID: 'e-owned-en', cardID: 'sm7-1-jp' }),
      );
    });
    await waitFor(() => expect(onBack).toHaveBeenCalled());
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
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ createInventoryEntry }),
      },
    );

    // ADD ITEM is disabled until the card detail resolves, so wait for the
    // loaded card before pressing — otherwise the press is a no-op. ADD ITEM now
    // opens the Add to Collection sheet; the add commits from its confirm CTA.
    await screen.findByTestId('detail-name');
    fireEvent.press(screen.getByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-confirm'));

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
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ createInventoryEntry }),
      },
    );

    // Add Item opens at the Raw default; switch the grader to PSA inside the sheet.
    fireEvent.press(await screen.findByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-confirm'));

    await waitFor(() => {
      expect(createInventoryEntry).toHaveBeenCalledWith(expect.objectContaining({
        cardID: 'sm7-1',
        condition: null,
        slabContext: expect.objectContaining({ grader: 'PSA', grade: '10' }),
      }));
    });
  });

  it('after adding a graded card it becomes owned and the bar switches to SAVE / CANCEL edit mode', async () => {
    const createInventoryEntry = jest.fn(async () => ({
      deckEntryID: 'g1',
      cardID: 'sm7-1',
      addedAt: '2026-06-04T00:00:00.000Z',
    }));

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ createInventoryEntry }) },
    );

    // Graded lane add — Add Item opens at Raw, switch to PSA inside the sheet.
    fireEvent.press(await screen.findByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-confirm'));

    // The optimistic add makes the card owned, so the action bar flips to the
    // owned-card edit controls (SAVE / CANCEL, Figma 1874:21729) — ADD ITEM gone.
    await waitFor(() => expect(screen.getByTestId('detail-save-edit')).toBeTruthy());
    expect(screen.getByTestId('detail-cancel-edit')).toBeTruthy();
    expect(screen.queryByTestId('detail-add-item')).toBeNull();
  }, 10000);

  /*
    Used to `dismissTo` the tabs root with a dead `page` param — and the tabs root
    is the feed now, so adding from search dropped you there. Popping ONE screen
    returns you to whatever pushed this page.
  */
  it('returns to the screen you came from after adding, and leaves a confirmation', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
    );

    fireEvent.press(await screen.findByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-confirm'));

    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    // The whole stack must NOT be collapsed — that is what took you to the feed.
    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(consumeCardAddedNotice()).toBe('Added to your collection');
  }, 10000);

  it('opens the grade/condition picker and selects a new condition for the raw lane', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
      />,
    );

    // Grade lives in the Add to Collection sheet now: open it, then its grade
    // trigger opens the grade/condition picker.
    fireEvent.press(await screen.findByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-grade-trigger'));
    // The grade sheet animates open; allow extra time so this stays green under
    // full-suite load (not just when the file runs in isolation).
    fireEvent.press(
      await screen.findByTestId('detail-grade-sheet-option-lightly_played', {}, { timeout: 5000 }),
    );

    // Selecting closes the sheet, so the option unmounts.
    await waitFor(() => {
      expect(screen.queryByTestId('detail-grade-sheet-option-lightly_played')).not.toBeOnTheScreen();
    }, { timeout: 5000 });
  });

  it('switches the grade picker to numeric grades when a graded grader is selected', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
      />,
    );

    // Add Item opens at Raw; switching the grader to BGS inside the sheet flips
    // the grade picker from conditions to numeric grades.
    fireEvent.press(await screen.findByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-configurator-grader-BGS'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-grade-trigger'));

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
    // …and the graded rows actually RENDER (not just fetched).
    expect(await screen.findByTestId('detail-price-trends-row-PSA 10')).toBeTruthy();
  });

  // The backend emits two row-key shapes depending on version: the staging shape
  // (graded "PSA 10", raw "NM") and the pipe shape (graded "PSA|10|<variant>", raw
  // "<variant>|NM"). The deep-link handler must parse BOTH.
  const trendRows = (mode: string, pipeKeys = false) => ([
    {
      label: mode === 'graded' ? 'PSA 10' : 'Near Mint',
      key: mode === 'graded'
        ? (pipeKeys ? 'PSA|10|holofoil' : 'PSA 10')
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
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
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
    // Tracked for the "checks pricing" funnel.
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'tcgplayer',
      lane: 'raw',
    });
  });

  const recentSalesRecord = {
    source: 'ebay' as const,
    status: 'available' as const,
    fetchedAt: new Date().toISOString(),
    canRefresh: false,
    saleCount: 5,
    sales: [0, 1, 2, 3, 4].map((index) => ({
      id: `sale-${index}`,
      // Sale 0 carries a leading PSA cert number, like real seller titles.
      title: `${index === 0 ? '140550170 ' : ''}Gengar ex 088/091 SV5K Japanese PSA 10 lot-${index}`,
      soldAt: '2026-07-10T00:00:00.000Z',
      priceAmount: 100 + index,
      currencyCode: 'USD',
      saleUrl: `https://www.ebay.com/itm/10${index}`,
    })),
  };

  it('graded price-trend row expands the inline last-solds accordion (no browser exit)', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const getCardRecentSales = jest.fn(async () => recentSalesRecord);
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardPriceTrends,
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    // The row expands INLINE — no browser exit on the row tap itself.
    await waitFor(() => {
      expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    });
    expect(openURL).not.toHaveBeenCalled();
    // refresh:true rides the backend's 24h TTL guard (the credit gate).
    expect(getCardRecentSales).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'sm7-1',
        // Space-form key ("PSA 10") carries no printing → falls back to the
        // configurator's selected variant, scoping the backend comp filter.
        slabContext: { grader: 'PSA', grade: '10', variantName: 'Normal' },
        source: 'ebay',
        limit: 20,
        refresh: true,
      }),
    );
    // One chevron opens BOTH panels, so the expand carries both cache states.
    expect(capturePostHogEvent).toHaveBeenCalledWith('pdp_recent_sales_expanded', {
      grader: 'PSA',
      grade: '10',
      cache: 'cold',
      listed_cache: 'cold',
    });

    // Paywall off: every sale renders clear, with no blur layer and no upsell.
    expect(screen.getByTestId('detail-recent-sales-sale-0')).toBeTruthy();
    expect(screen.queryByTestId('detail-recent-sales-locked')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-subscribe')).toBeNull();
    // Clear sale's price renders INSIDE the panel (the trend row shows $100 too).
    expect(
      within(screen.getByTestId('detail-recent-sales-sale-0')).getByText('$100.00'),
    ).toBeTruthy();
    // The leading cert number ("140550170 …") is stripped from the shown title.
    expect(
      within(screen.getByTestId('detail-recent-sales-sale-0')).getByText(
        'Gengar ex 088/091 SV5K Japanese PSA 10 lot-0',
      ),
    ).toBeTruthy();

    // Tapping the clear sale opens the EXACT sold listing.
    fireEvent.press(screen.getByTestId('detail-recent-sales-sale-0'));
    expect(openURL).toHaveBeenCalledWith('https://www.ebay.com/itm/100');

    // "See more on eBay" now sits under a POPULATED panel too (user request:
    // always offer the jump-out, data or not). It became reasonable once the
    // search query was simplified to a single readable phrase — what eBay shows
    // is legible and editable, unlike the old paren-soup title search that got
    // this link removed the first time.
    expect(screen.getByTestId('detail-recent-sales-see-more')).toBeTruthy();

    // Second tap on the row collapses the accordion.
    fireEvent.press(screen.getByTestId('detail-price-trends-row-PSA 10'));
    expect(screen.queryByTestId('detail-recent-sales')).toBeNull();

    // Re-expand: served from the per-row cache — no second fetch.
    fireEvent.press(screen.getByTestId('detail-price-trends-row-PSA 10'));
    expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    expect(getCardRecentSales).toHaveBeenCalledTimes(1);
  });

  /*
    EMPTY COMPS ARE A DEAD END WITHOUT THIS.

    When a panel has nothing to show, the only thing on screen is a gray "none
    found" line. The fallback hands the user off to eBay's own search for the
    same card — sold comps under Recent Sales, cheapest-first live listings
    under Lowest Listed.
  */
  it('offers an eBay search out of BOTH panels when they come back empty', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const getCardRecentSales = jest.fn(async () => ({
      ...recentSalesRecord,
      saleCount: 0,
      sales: [],
    }));
    const getCardEbayListings = jest.fn(async () => ({
      status: 'available' as const,
      listingCount: 0,
      listings: [],
    }));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({
        getCardPriceTrends,
        getCardRecentSales,
        getCardEbayListings,
      }),
    });

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    const soldLink = await screen.findByTestId('detail-recent-sales-see-more');
    fireEvent.press(soldLink);

    // Sold comps: eBay's ended-listings page for this exact grade.
    const soldUrl = openURL.mock.calls[0][0] as string;
    expect(soldUrl).toContain('ebay.com/sch/i.html');
    expect(soldUrl).toContain('LH_Sold=1');
    // `searchParams` (not decodeURIComponent) — the query encodes spaces as "+".
    expect(new URL(soldUrl).searchParams.get('_nkw')).toContain('"PSA 10"');
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
      surface: 'pdp_recent_sales_empty',
    });

    const listedLink = await screen.findByTestId('detail-lowest-listed-see-more');
    fireEvent.press(listedLink);

    // Live listings: no ended-listing filters, cheapest first.
    const activeUrl = openURL.mock.calls[1][0] as string;
    expect(activeUrl).not.toContain('LH_Sold');
    expect(activeUrl).toContain('_sop=15');
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
      surface: 'pdp_lowest_listed_empty',
    });
  });

  /*
    "See more on eBay" renders under a POPULATED panel as well as an empty one,
    but both branches reported `..._empty` — so every exit from a full panel was
    filed as "there was nothing here". Same trip out to eBay, opposite meaning.
    Individual row taps reported nothing at all.
  */
  it('separates the eBay exits: populated vs empty, and per-row taps', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const getCardRecentSales = jest.fn(async () => recentSalesRecord);
    const getCardEbayListings = jest.fn(async () => ({
      status: 'available' as const,
      listingCount: 2,
      listings: [0, 1].map((index) => ({
        id: `listing-${index}`,
        title: `Gengar ex 088/091 PSA 10 listing-${index}`,
        priceAmount: 200 + index,
        currencyCode: 'USD',
        saleType: 'fixed_price',
        listingUrl: `https://www.ebay.com/itm/20${index}`,
      })),
    }));
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({
        getCardPriceTrends,
        getCardRecentSales,
        getCardEbayListings,
      }),
    });

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    // A sold row and a listing row each open one specific eBay page.
    fireEvent.press(await screen.findByTestId('detail-recent-sales-sale-0'));
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
      surface: 'pdp_recent_sales_row',
    });

    fireEvent.press(await screen.findByTestId('detail-lowest-listed-listing-0'));
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
      surface: 'pdp_lowest_listed_row',
    });

    // …and the footer search, from panels that DO have rows.
    fireEvent.press(await screen.findByTestId('detail-recent-sales-see-more'));
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
      surface: 'pdp_recent_sales',
    });

    fireEvent.press(await screen.findByTestId('detail-lowest-listed-see-more'));
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
      surface: 'pdp_lowest_listed',
    });

    // Closing the chevron is its own event; it used to report nothing.
    fireEvent.press(screen.getByTestId('detail-price-trends-row-PSA 10'));
    expect(capturePostHogEvent).toHaveBeenCalledWith('pdp_comps_collapsed', {
      grader: 'PSA',
      grade: '10',
    });
  });

  it('premium: 5 clear sales, then "Show more" reveals the rest in place (no extra fetch)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const premiumSpy = jest
      .spyOn(require('@/features/monetization/entitlements'), 'useIsPremium')
      .mockReturnValue(true);
    const manySalesRecord = {
      ...recentSalesRecord,
      saleCount: 8,
      sales: [0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
        id: `sale-${index}`,
        title: `Gengar ex 088/091 SV5K Japanese PSA 10 lot-${index}`,
        soldAt: '2026-07-10T00:00:00.000Z',
        priceAmount: 100 + index,
        currencyCode: 'USD',
        saleUrl: `https://www.ebay.com/itm/10${index}`,
      })),
    };
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const getCardRecentSales = jest.fn(async () => manySalesRecord);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardPriceTrends,
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    });

    // Premium first slice: 5 clear rows, no blur/subscribe, Show-more present.
    expect(screen.getByTestId('detail-recent-sales-sale-4')).toBeTruthy();
    expect(screen.queryByTestId('detail-recent-sales-sale-5')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-locked')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-subscribe')).toBeNull();
    fireEvent.press(screen.getByTestId('detail-recent-sales-show-more'));

    // All 8 now clear, button gone, and NO second fetch — the extra rows come
    // from the same cached page.
    expect(screen.getByTestId('detail-recent-sales-sale-7')).toBeTruthy();
    expect(screen.queryByTestId('detail-recent-sales-show-more')).toBeNull();
    expect(getCardRecentSales).toHaveBeenCalledTimes(1);
    expect(capturePostHogEvent).toHaveBeenCalledWith('pdp_recent_sales_show_more', {
      grader: 'PSA',
      grade: '10',
    });
    premiumSpy.mockRestore();
  });

  it('shows every recent sale to everyone — the paywall is off', async () => {
    const manySalesRecord = {
      ...recentSalesRecord,
      saleCount: 8,
      sales: [0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
        id: `sale-${index}`,
        title: `Gengar ex 088/091 SV5K Japanese PSA 10 lot-${index}`,
        soldAt: '2026-07-10T00:00:00.000Z',
        priceAmount: 100 + index,
        currencyCode: 'USD',
        saleUrl: `https://www.ebay.com/itm/10${index}`,
      })),
    };
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const getCardRecentSales = jest.fn(async () => manySalesRecord);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardPriceTrends,
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    });

    /*
      `PAYWALL_ENABLED` is false, so there is no free tier to be on: comps are
      not something to hold back while we are still getting people to use the
      app. Nothing is blurred, nothing is counted as hidden, and there is no
      upsell to tap.
    */
    expect(screen.getByTestId('detail-recent-sales-sale-0')).toBeTruthy();
    expect(screen.getByTestId('detail-recent-sales-sale-1')).toBeTruthy();
    expect(screen.queryByTestId('detail-recent-sales-locked-0')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-locked-3')).toBeNull();
    expect(screen.queryByText('7 more recent sales')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-subscribe')).toBeNull();
  });

  it('offers no subscribe CTA at all, so no paywall event can fire', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const getCardRecentSales = jest.fn(async () => recentSalesRecord);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardPriceTrends,
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    });

    // With the paywall off there is no CTA to press, so the event it used to
    // fire cannot happen. Asserting the EVENT as well as the button matters:
    // a stray upsell elsewhere would still be reporting an intent to charge.
    expect(screen.queryByTestId('detail-recent-sales-subscribe')).toBeNull();
    expect(capturePostHogEvent).not.toHaveBeenCalledWith(
      'paywall_subscribe_tapped',
      expect.anything(),
    );
  });

  it('parses the pipe-delimited graded row key too (backend version robustness)', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode, true),
    }));
    const getCardRecentSales = jest.fn(async () => recentSalesRecord);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardPriceTrends,
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA|10|holofoil'));

    // The pipe key "PSA|10|<variant>" yields grader=PSA, grade=10 AND carries
    // the printing through to the recent-sales fetch (scopes the backend's
    // off-variant comp filter).
    await waitFor(() => {
      expect(getCardRecentSales).toHaveBeenCalledWith(
        expect.objectContaining({
          slabContext: { grader: 'PSA', grade: '10', variantName: 'holofoil' },
        }),
      );
    });
    expect(await screen.findByTestId('detail-recent-sales')).toBeTruthy();
  });

  it('tapping the TCGplayer logo (raw lane) opens the Near Mint search', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    fireEvent.press(await screen.findByTestId('detail-price-trends-provider'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    const url = openURL.mock.calls[0][0] as string;
    expect(url).toContain('tcgplayer.com/search');
    expect(url).toContain('Condition=Near+Mint');
    expect(url).not.toContain('Printing=');
  });

  it('does not make the graded-lane eBay logo a link (its search was inaccurate)', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode),
    }));

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    // Raw lane: the TCGplayer logo IS a pressable link (covered above). Switch to
    // the graded (eBay) lane — its logo is now a static image, so the pressable
    // provider button is absent.
    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    await waitFor(() => {
      expect(screen.queryByTestId('detail-price-trends-provider')).not.toBeOnTheScreen();
    });
  });

  it('a graded-only card (no raw pricing) defaults to the graded lane so a chart shows', async () => {
    // ~971 grail cards (e.g. Poncho-wearing Pikachu) have NO raw pricing but DO
    // have graded pricing. The default seeds Raw, which would show a blank page;
    // the post-load correction must flip the default to a graded lane (PSA 10).
    const baseRepository = createTestSpotlightRepository();
    const getCardDetail = jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail(query);
      if (!base) {
        return null;
      }
      return {
        ...base,
        // No raw pricing: null top-level price, empty variant lists, empty
        // history points; currentPrice coerced to 0 by the backend.
        marketPrice: null,
        variantOptions: [],
        marketHistory: {
          ...base.marketHistory,
          currentPrice: 0,
          points: [],
          availableVariants: [],
          availableConditions: [],
        },
        // The backend flags graded-only cards with the headline graded lane to
        // open on (non-null ONLY when there's no raw price but graded exists).
        gradedReference: {
          grader: 'PSA',
          grade: '10',
          market: 24824.52,
          currencyCode: 'USD',
          label: 'PSA 10',
        },
      } satisfies CardDetailRecord;
    });
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: query.mode === 'graded'
        ? [{ label: 'PSA 10', key: 'PSA 10', currentPrice: 1500, currencyCode: 'USD', points: [1, 2, 3], trendPct: 5 }]
        : [],
    }));

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardDetail, getCardPriceTrends }) },
    );

    // The correction flips the seeded Raw default to the PSA graded lane…
    await waitFor(() => {
      expect(screen.getByTestId('detail-configurator-grader-PSA').props.accessibilityState?.selected).toBe(true);
    });
    expect(screen.getByTestId('detail-configurator-grader-Raw').props.accessibilityState?.selected).toBe(false);

    // …and the graded price trends are fetched + rendered (not a blank page).
    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: 'sm7-1', mode: 'graded', grader: 'PSA' }),
      );
    });
    expect(await screen.findByTestId('detail-price-trends-row-PSA 10')).toBeTruthy();
  });

  it('a card WITH raw pricing keeps the Raw lane default (no graded auto-switch)', async () => {
    // Guardrail: the correction must not fire for normal cards that have raw
    // pricing, even when population data is present.
    const baseRepository = createTestSpotlightRepository();
    const getCardDetail = jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail(query);
      return base
        ? ({
            ...base,
            population: { PSA: { totalPopulation: 4, gemRate: 0.25, grades: { '10': 1 } } },
          } satisfies CardDetailRecord)
        : null;
    });

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardDetail }) },
    );

    // Raw stays selected; the graded auto-switch never fires for a priced card.
    await screen.findByTestId('detail-configurator');
    await waitFor(() => {
      expect(screen.getByTestId('detail-configurator-variant-normal').props.accessibilityState?.selected).toBe(true);
    });
    expect(screen.getByTestId('detail-configurator-grader-Raw').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('detail-configurator-grader-PSA').props.accessibilityState?.selected).toBe(false);
  });

  it('renders Product Details when the card detail includes cardText', async () => {
    const baseRepository = createTestSpotlightRepository();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
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
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ setCardFavorite }),
      },
    );

    const heart = await screen.findByTestId('detail-hero-card-favorite');
    expect(heart.props.accessibilityLabel).toBe('Add to wishlist');

    fireEvent.press(heart);
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenLastCalledWith('sm7-1', true);
      expect(screen.getByTestId('detail-hero-card-favorite').props.accessibilityLabel)
        .toBe('Remove from wishlist');
    });

    fireEvent.press(screen.getByTestId('detail-hero-card-favorite'));
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenLastCalledWith('sm7-1', false);
      expect(screen.getByTestId('detail-hero-card-favorite').props.accessibilityLabel)
        .toBe('Add to wishlist');
    });
  });

  it('drops the cached card detail when favoriting so reopening shows the true heart state', async () => {
    const setCardFavorite = jest.fn(async (cardId: string, isFavorite?: boolean | null) => ({
      cardId,
      favoritedAt: (isFavorite ?? true) ? '2026-05-15T00:00:00.000Z' : null,
      isFavorite: isFavorite ?? true,
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({ setCardFavorite }),
      },
    );

    // The PDP load warms the short-TTL detail cache for this card.
    await waitFor(() => {
      expect(hasFreshCardDetail('sm7-1')).toBe(true);
    });

    // Toggling favorite must drop that cache entry — otherwise reopening the PDP
    // within the TTL would read the stale (pre-toggle) `isFavorite` and show the
    // wrong heart even though the favorite persisted to the wishlist.
    fireEvent.press(await screen.findByTestId('detail-hero-card-favorite'));
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenCalledWith('sm7-1', true);
      expect(hasFreshCardDetail('sm7-1')).toBe(false);
    });
  });

  it('an owned graded entry opens in edit mode with the grade seeded from the slab', async () => {
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

    // Owned → SAVE / CANCEL edit bar (no ADD ITEM), and the inline Condition
    // dropdown is seeded from the owned slab — the bare grade "10" (Figma).
    expect(await screen.findByTestId('detail-save-edit')).toBeTruthy();
    expect(screen.queryByTestId('detail-add-item')).toBeNull();
    const trigger = await screen.findByTestId('detail-owned-edit-grade-trigger');
    expect(within(trigger).getByText('10')).toBeTruthy();
  });

  function renderOwnedEntryWithSinceAdded(overrides: Partial<InventoryCardEntry>) {
    const baseRepository = createTestSpotlightRepository();
    const ownedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'raw-treecko',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 600,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: null,
      variantName: null,
      ...overrides,
    };

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" entryId="raw-treecko" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [ownedEntry] } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );
  }

  it('shows the "since added" position row for an owned entry with a baseline', async () => {
    renderOwnedEntryWithSinceAdded({
      sinceAddedChangeAmount: 142,
      sinceAddedChangePercent: 31,
      sinceAddedBaselineDate: '2026-03-12',
    });

    const row = await screen.findByTestId('detail-since-added');
    expect(screen.getByTestId('detail-since-added-icon')).toBeTruthy();
    expect(within(row).getByTestId('detail-since-added-amount').props.children)
      .toBe('$142.00 (31.00%)');
    expect(within(row).getByTestId('detail-since-added-caption').props.children)
      .toBe('since added Mar 12');
  });

  it('captions the row "since we started tracking it" when the baseline postdates the add date (pre-history fallback)', async () => {
    renderOwnedEntryWithSinceAdded({
      // Entry added before price tracking began: baseline resolves to the
      // earliest tracked price, which is LATER than addedAt.
      addedAt: '2026-01-05T12:00:00.000Z',
      sinceAddedChangeAmount: -20.5,
      sinceAddedChangePercent: -3.3,
      sinceAddedBaselineDate: '2026-02-01',
    });

    const row = await screen.findByTestId('detail-since-added');
    expect(screen.getByTestId('detail-since-added-icon')).toBeTruthy();
    expect(within(row).getByTestId('detail-since-added-amount').props.children)
      .toBe('$20.50 (3.30%)');
    expect(within(row).getByTestId('detail-since-added-caption').props.children)
      .toBe('since we started tracking it Feb 1');
  });

  it('renders a flat position without a triangle and without sign confusion', async () => {
    renderOwnedEntryWithSinceAdded({
      sinceAddedChangeAmount: 0,
      sinceAddedChangePercent: 0,
      sinceAddedBaselineDate: '2026-03-12',
    });

    const row = await screen.findByTestId('detail-since-added');
    expect(screen.queryByTestId('detail-since-added-icon')).toBeNull();
    expect(within(row).getByTestId('detail-since-added-amount').props.children)
      .toBe('$0.00 (0.00%)');
    expect(within(row).getByTestId('detail-since-added-caption').props.children)
      .toBe('since added Mar 12');
  });

  it('renders no position row when the owned entry has no since-added baseline', async () => {
    renderOwnedEntryWithSinceAdded({
      sinceAddedChangeAmount: null,
      sinceAddedChangePercent: null,
      sinceAddedBaselineDate: null,
    });

    // Wait for the screen to settle, then confirm the row never appeared.
    expect(await screen.findByTestId('detail-name')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('detail-save-edit')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-since-added')).toBeNull();
  });

  it('shows the "since wishlisted" position row from favoriteContext for a wishlisted-but-unowned card', async () => {
    const baseRepository = createTestSpotlightRepository();
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({
                  ...detail,
                  ownedEntries: [],
                  favoriteContext: {
                    favoritedAt: '2026-07-02T12:00:00.000Z',
                    sinceAddedChangeAmount: 12.5,
                    sinceAddedChangePercent: 4.1,
                    sinceAddedBaselineDate: '2026-07-02',
                  },
                } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    const row = await screen.findByTestId('detail-since-added');
    expect(screen.getByTestId('detail-since-added-icon')).toBeTruthy();
    expect(within(row).getByTestId('detail-since-added-amount').props.children)
      .toBe('$12.50 (4.10%)');
    expect(within(row).getByTestId('detail-since-added-caption').props.children)
      .toBe('since wishlisted Jul 2');
  });

  it('an owned entry beats favoriteContext: only the owned "since added" variant renders', async () => {
    const baseRepository = createTestSpotlightRepository();
    const ownedEntry: InventoryCardEntry = {
      addedAt: '2026-03-12T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'raw-treecko',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 600,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      sinceAddedBaselineDate: '2026-03-12',
      sinceAddedChangeAmount: 142,
      sinceAddedChangePercent: 31,
      slabContext: null,
      variantName: null,
    };

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" entryId="raw-treecko" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({
                  ...detail,
                  ownedEntries: [ownedEntry],
                  favoriteContext: {
                    favoritedAt: '2026-07-02T12:00:00.000Z',
                    sinceAddedChangeAmount: -5,
                    sinceAddedChangePercent: -1,
                    sinceAddedBaselineDate: '2026-07-02',
                  },
                } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    // Exactly ONE row, and it is the owned variant — the wishlist context must
    // not leak in even though the card is also favorited.
    const row = await screen.findByTestId('detail-since-added');
    expect(screen.getAllByTestId('detail-since-added')).toHaveLength(1);
    expect(within(row).getByTestId('detail-since-added-amount').props.children)
      .toBe('$142.00 (31.00%)');
    expect(within(row).getByTestId('detail-since-added-caption').props.children)
      .toBe('since added Mar 12');
  });

  function ownedGradedEntry(quantity: number): InventoryCardEntry {
    return {
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
      quantity,
      setName: 'Sky Stream',
      slabContext: { certNumber: '00012345', grade: '10', grader: 'PSA', variantName: 'PSA 10' },
      variantName: 'PSA 10',
    };
  }

  function renderOwnedGraded(
    overrides: Partial<React.ComponentProps<typeof CardDetailScreen>>,
    repoOverrides: Parameters<typeof createTestSpotlightRepository>[0],
  ) {
    const baseRepository = createTestSpotlightRepository();
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" entryId="graded-treecko-psa10" onBack={jest.fn()} {...overrides} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [ownedGradedEntry(6)] } satisfies CardDetailRecord)
              : null;
          },
          ...repoOverrides,
        }),
      },
    );
  }

  it('owned cards show the SAVE / CANCEL edit bar (Figma 1874:21729), not ADD ITEM', async () => {
    // Owned cards edit in place: the bottom bar is SAVE + CANCEL, and the old
    // ADD ITEM / managed-copy controls do not render.
    renderOwnedGraded({}, {});

    expect(await screen.findByTestId('detail-save-edit')).toBeTruthy();
    expect(screen.getByTestId('detail-cancel-edit')).toBeTruthy();
    expect(screen.queryByTestId('detail-add-item')).toBeNull();
    expect(screen.queryByTestId('detail-share-button')).toBeNull();
    expect(screen.queryByTestId('detail-add-copy')).toBeNull();
    expect(screen.queryByTestId('detail-remove-item')).toBeNull();
  });

  it('SAVE persists edits via replace + cost basis and returns to Collection', async () => {
    const replacePortfolioEntry = jest.fn(async () => ({
      previousDeckEntryID: 'graded-treecko-psa10',
      deckEntryID: 'graded-treecko-psa10',
      cardID: 'sm7-1',
      quantity: 6,
      unitPrice: 40,
      updatedAt: '2026-06-29T00:00:00.000Z',
    }));
    const updateDeckEntryCostBasis = jest.fn(async () => ({
      deckEntryID: 'graded-treecko-psa10',
      cardID: 'sm7-1',
      costBasisPerUnit: 40,
      costBasisPerUnitCents: 4000,
      currencyCode: 'USD',
      updatedAt: '2026-06-29T00:00:00.000Z',
    }));
    const onBack = jest.fn();

    renderOwnedGraded({ onBack }, { replacePortfolioEntry, updateDeckEntryCostBasis });

    fireEvent.changeText(
      await screen.findByTestId('detail-owned-edit-cost-basis-input'),
      '40',
    );
    fireEvent.press(screen.getByTestId('detail-save-edit'));

    await waitFor(() => expect(replacePortfolioEntry).toHaveBeenCalledTimes(1));
    expect(replacePortfolioEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        deckEntryID: 'graded-treecko-psa10',
        cardID: 'sm7-1',
        quantity: 6,
        unitPrice: 40,
        condition: null,
        slabContext: expect.objectContaining({ grader: 'PSA', grade: '10' }),
      }),
    );
    await waitFor(() =>
      expect(updateDeckEntryCostBasis).toHaveBeenCalledWith(
        expect.objectContaining({ deckEntryID: 'graded-treecko-psa10', costBasisPerUnit: 40 }),
      ),
    );
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it('Raw→Graded conversion carries the raw print variant onto the slab (per-printing pricing)', async () => {
    // A raw owned entry carries a raw print variant (here "Normal"; in the wild a
    // raw-only stamp like "League Stamp"). When the user switches the grader to
    // PSA, the raw variant must NOT be stamped onto the graded slab: graded
    // pricing is keyed by (grade, variant) and a raw-only variant has no graded
    // price, so the slab would show a blank price. Sending variantName=null lets
    // the backend graded resolver fall back to an available graded variant.
    const rawEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'raw-treecko-normal',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 0.31,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: null,
      variantName: 'Normal',
    };

    const replacePortfolioEntry = jest.fn(async () => ({
      previousDeckEntryID: 'raw-treecko-normal',
      deckEntryID: 'graded-treecko-psa10',
      cardID: 'sm7-1',
      quantity: 1,
      unitPrice: 0,
      updatedAt: '2026-06-29T00:00:00.000Z',
    }));
    const updateDeckEntryCostBasis = jest.fn(async () => ({
      deckEntryID: 'graded-treecko-psa10',
      cardID: 'sm7-1',
      costBasisPerUnit: 0,
      costBasisPerUnitCents: 0,
      currencyCode: 'USD',
      updatedAt: '2026-06-29T00:00:00.000Z',
    }));

    const baseRepository = createTestSpotlightRepository();
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" entryId="raw-treecko-normal" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [rawEntry] } satisfies CardDetailRecord)
              : null;
          },
          replacePortfolioEntry,
          updateDeckEntryCostBasis,
        }),
      },
    );

    // The entry opens in Raw edit mode. Switch the grader to PSA via the
    // configurator grader chips (Raw → PSA conversion).
    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-save-edit'));

    await waitFor(() => expect(replacePortfolioEntry).toHaveBeenCalledTimes(1));
    // The slab is graded (PSA 10) and — the core assertion — CARRIES the raw
    // print variant ("Normal") onto the slab so graded pricing stays
    // per-printing (a Normal PSA 10 ≠ Reverse Holo PSA 10). The backend graded
    // resolver falls back only if the label has no matching graded printing.
    expect(replacePortfolioEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        slabContext: expect.objectContaining({
          grader: 'PSA',
          grade: '10',
          variantName: 'Normal',
        }),
      }),
    );
  });

  // Regression: a quantity-only edit REPLACED the entry instead of updating it.
  // The variant seed resolves a NULL-variant raw entry to "Normal" (the first
  // catalog option), and saving that seeded label changed the identity key —
  // the backend then zeroed the old row and inserted a NEW one, and on the
  // replace path the new row lost the entry's collection_id ("I increased the
  // quantity and the card disappeared" from its collection). The SAVE payload
  // must carry the entry's STORED variant (here: null) so the identity key is
  // unchanged and the backend updates the row in place, preserving its
  // collection. Only an explicit user variant pick may change the identity.
  function nullVariantRawEntry(): InventoryCardEntry {
    return {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'raw-treecko-no-variant',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 0.31,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: null,
      variantName: null,
    };
  }

  function renderOwnedRawNoVariant(repoOverrides: Parameters<typeof createTestSpotlightRepository>[0]) {
    // A prior test's save chain can bump its provider's dataVersion during
    // teardown (afterEach runs BEFORE RTL's auto-unmount), re-populating the
    // module-level card-detail cache with ITS repository's sm7-1 detail after
    // afterEach already cleared it. Clear again so this render fetches from
    // THIS test's repository.
    clearCardDetailCache();
    const baseRepository = createTestSpotlightRepository();
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" entryId="raw-treecko-no-variant" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [nullVariantRawEntry()] } satisfies CardDetailRecord)
              : null;
          },
          ...repoOverrides,
        }),
      },
    );
  }

  function replaceAndCostBasisMocks() {
    const replacePortfolioEntry = jest.fn(async () => ({
      previousDeckEntryID: 'raw-treecko-no-variant',
      deckEntryID: 'raw-treecko-no-variant',
      cardID: 'sm7-1',
      quantity: 2,
      unitPrice: 0,
      updatedAt: '2026-06-29T00:00:00.000Z',
    }));
    const updateDeckEntryCostBasis = jest.fn(async () => ({
      deckEntryID: 'raw-treecko-no-variant',
      cardID: 'sm7-1',
      costBasisPerUnit: null,
      costBasisPerUnitCents: null,
      currencyCode: 'USD',
      updatedAt: '2026-06-29T00:00:00.000Z',
    }));
    return { replacePortfolioEntry, updateDeckEntryCostBasis };
  }

  it('a quantity-only SAVE keeps the stored identity: variantName stays null, not the seeded "Normal"', async () => {
    const { replacePortfolioEntry, updateDeckEntryCostBasis } = replaceAndCostBasisMocks();
    renderOwnedRawNoVariant({ replacePortfolioEntry, updateDeckEntryCostBasis });

    // Bump the quantity — touch NOTHING else (no variant, grader, condition).
    fireEvent.press(await screen.findByTestId('detail-owned-edit-quantity-increment'));
    // Let the configurator's variant seed land ("Normal" chip selected) so the
    // test proves SAVE ignores the seeded label, not that it raced the seed.
    expect(await screen.findByTestId('detail-configurator-variant-normal')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-save-edit'));

    await waitFor(() => expect(replacePortfolioEntry).toHaveBeenCalledTimes(1));
    // The payload's identity fields mirror the STORED entry exactly — same
    // card, null variant, raw (no slab). Identity key unchanged means the
    // backend updates the row in place and the entry keeps its collection_id.
    expect(replacePortfolioEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        deckEntryID: 'raw-treecko-no-variant',
        cardID: 'sm7-1',
        quantity: 2,
        variantName: null,
        slabContext: null,
        condition: 'near_mint',
      }),
    );
  });

  it('an explicit variant pick before SAVE still changes the identity (user intent wins)', async () => {
    const { replacePortfolioEntry, updateDeckEntryCostBasis } = replaceAndCostBasisMocks();
    renderOwnedRawNoVariant({ replacePortfolioEntry, updateDeckEntryCostBasis });

    // The user deliberately picks the "Raw" variant chip, then saves.
    fireEvent.press(await screen.findByTestId('detail-configurator-variant-raw'));
    fireEvent.press(screen.getByTestId('detail-save-edit'));

    await waitFor(() => expect(replacePortfolioEntry).toHaveBeenCalledTimes(1));
    expect(replacePortfolioEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        deckEntryID: 'raw-treecko-no-variant',
        variantName: 'Raw',
      }),
    );
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
        scanReviewId={scanReviewId}
      />,
    );

    // The action buttons still render, but the "N similar" button is gone.
    expect(await screen.findByTestId('detail-add-item')).toBeTruthy();
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
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
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
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: repository },
    );

    // The screen reads through the cache → the trend list renders…
    await waitFor(() => {
      expect(screen.getByTestId('detail-price-trends')).toBeTruthy();
    });
    // …and the default raw/Normal lane was NOT re-requested over the network.
    expect(getCardPriceTrends).toHaveBeenCalledTimes(callsAfterPrefetch);
  });

  /*
    The keyboard used to cover the bottom of the page. The scroll content
    reserved only `footerHeight`, so with the keyboard up there was nowhere left
    to scroll: the programmatic scroll clamped at max offset and left Cost Basis
    under the lifted SAVE/CANCEL row, and the rest of the card was unreachable.
  */
  it('reserves scroll room for the keyboard so the page stays reachable', async () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const addListener = jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation(((event: string, cb: (e: unknown) => void) => {
        listeners[event] = cb;
        return { remove: jest.fn() };
      }) as never);

    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />);
    const scrollView = await screen.findByTestId('detail-scroll');

    const restingPadding = StyleSheet.flatten(
      scrollView.props.contentContainerStyle,
    ).paddingBottom as number;

    await act(async () => {
      listeners.keyboardDidShow?.({ endCoordinates: { height: 336 } });
    });

    const liftedPadding = StyleSheet.flatten(
      screen.getByTestId('detail-scroll').props.contentContainerStyle,
    ).paddingBottom as number;
    // The keyboard's whole height becomes scrollable room — the same number the
    // footer climbs by, so footer + keyboard can both be cleared.
    expect(liftedPadding).toBe(restingPadding + 336);

    await act(async () => {
      listeners.keyboardDidHide?.({});
    });

    expect(
      StyleSheet.flatten(
        screen.getByTestId('detail-scroll').props.contentContainerStyle,
      ).paddingBottom,
    ).toBe(restingPadding);

    addListener.mockRestore();
  });

  it('renders an unavailable state when the repository returns no local card detail', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="missing-card-id"
        onBack={jest.fn()}
      />,
    );

    expect(await screen.findByText('Card unavailable')).toBeTruthy();
    expect(screen.getByText('We could not find this card in the local catalog.')).toBeTruthy();
  });
});
