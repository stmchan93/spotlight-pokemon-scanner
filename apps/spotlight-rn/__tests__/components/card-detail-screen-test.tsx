import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Linking, Share } from 'react-native';
import { useRouter } from 'expo-router';

import type { CardDetailRecord, CardText, InventoryCardEntry } from '@spotlight/api-client';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
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
    (useRouter as jest.Mock).mockReturnValue({ replace: mockReplace, push: jest.fn(), back: jest.fn() });
  });

  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearScanCandidateReviewSessions();
    clearCardDetailCache();
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
      expect(screen.queryByTestId('detail-grade-sheet-option-lightly_played')).toBeNull();
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

  it('graded price-trend row opens eBay sold-listings search scoped to the grade', async () => {
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

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    const url = openURL.mock.calls[0][0] as string;
    expect(url).toContain('https://www.ebay.com/sch/i.html');
    expect(url).toContain('_nkw=%22PSA+10%22'); // grader + grade lead the sold-search query
    expect(url).toContain('LH_Sold=1');
    expect(url).toContain('LH_Complete=1');
    // Tracked for the "checks pricing" funnel.
    expect(capturePostHogEvent).toHaveBeenCalledWith('pricing_link_opened', {
      marketplace: 'ebay',
      lane: 'graded',
    });
  });

  it('parses the pipe-delimited graded row key too (backend version robustness)', async () => {
    const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode, true),
    }));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      { spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends }) },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA|10|'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    // The pipe key "PSA|10|<variant>" still yields grader=PSA, grade=10 in the query.
    expect(openURL.mock.calls[0][0] as string).toContain('_nkw=%22PSA+10%22');
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

  it('tapping the eBay logo (graded lane) opens sold listings for the selected grade', async () => {
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

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-provider'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    const url = openURL.mock.calls[0][0] as string;
    expect(url).toContain('https://www.ebay.com/sch/i.html');
    expect(url).toContain('_nkw=%22PSA+10%22'); // defaults to the seeded PSA 10
    expect(url).toContain('LH_Sold=1');
  });

  it('keeps the PDP eBay link independent of the Add to Collection grade dropdown', async () => {
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

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    // Add Item opens at the Raw default; switch it to PSA and pick a different
    // grade (9.5) INSIDE the sheet, then dismiss it. The sheet owns its own
    // selection now, so this must NOT change the page — the PDP's eBay link keeps
    // its own selection (PSA 10).
    fireEvent.press(screen.getByTestId('detail-add-item'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-add-sheet-grade-trigger'));
    fireEvent.press(await screen.findByTestId('detail-grade-sheet-option-9.5'));
    fireEvent.press(screen.getByTestId('detail-add-sheet-backdrop'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-provider'));

    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    // The add-sheet selection did NOT leak to the page: still PSA 10, not 9.5.
    expect(openURL.mock.calls[0][0] as string).toContain('_nkw=%22PSA+10%22');
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
