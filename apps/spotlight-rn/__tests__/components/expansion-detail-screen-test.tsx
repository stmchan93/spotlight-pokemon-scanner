import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Share, StyleSheet } from 'react-native';

import {
  MockSpotlightRepository,
  type CatalogSearchResult,
  type ExpansionRecord,
  type InventoryCardEntry,
  type InventoryEntryCreateResponsePayload,
} from '@spotlight/api-client';
import { pickSetPageAccent } from '@/features/catalog/hooks/use-set-page-accent';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';

import { renderWithProviders } from '../test-utils';

// The screen reads the "Added to your collection" handoff on FOCUS; with no
// navigator above it, running the callback once on mount is the stand-in.
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => require('react').useEffect(callback, [callback]),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

function card(overrides: Partial<CatalogSearchResult> & { cardId: string; name: string }): CatalogSearchResult {
  return {
    id: overrides.cardId,
    cardNumber: '#001/120',
    setName: 'Delta Reign',
    imageUrl: 'https://cdn.spotlight.test/card.png',
    marketPrice: 1.5,
    currencyCode: 'USD',
    game: 'pokemon',
    ...overrides,
  };
}

function entry(overrides: Partial<InventoryCardEntry> & { id: string; cardId: string }): InventoryCardEntry {
  return {
    name: 'Card',
    cardNumber: '#001/120',
    setName: 'Delta Reign',
    imageUrl: '',
    marketPrice: 1,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-11-01T00:00:00.000Z',
    kind: 'raw',
    variantName: 'Normal',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    slabContext: null,
    ...overrides,
  };
}

const SET: ExpansionRecord = {
  id: 'dri',
  name: 'Delta Reign',
  series: null,
  code: 'DRI',
  language: 'English',
  releaseDate: '2026-05-22',
  imageUrl: 'https://cdn.spotlight.test/logo.png',
  cardCount: 3,
  setValue: 1012.78,
};

const CARDS = [
  card({ cardId: 'gengar', name: 'Gengar', cardNumber: '#001/120', rarityBucket: 'standard', ownedQuantity: 1 }),
  card({ cardId: 'mew', name: 'Mew', cardNumber: '#121/120', rarityBucket: 'secret', ownedQuantity: 0, marketPrice: null }),
  card({ cardId: 'lugia', name: 'Lugia', cardNumber: '#050/120', rarityBucket: 'ultra', ownedQuantity: 2 }),
];

const ENTRIES = [
  entry({ id: 'e-gengar', cardId: 'gengar', quantity: 1 }),
  entry({ id: 'e-lugia-raw', cardId: 'lugia', quantity: 1 }),
  entry({
    id: 'e-lugia-psa',
    cardId: 'lugia',
    quantity: 1,
    kind: 'graded',
    variantName: null,
    conditionCode: null,
    conditionLabel: null,
    slabContext: { grader: 'PSA', grade: '10', certNumber: null, variantName: 'PSA 10' },
  }),
];

const SEALED = [
  card({
    cardId: 'tcgp-sealed-1',
    name: 'Delta Reign Elite Trainer Box',
    cardNumber: '',
    productKind: 'sealed',
    sealedProductType: 'Elite Trainer Box',
    marketPrice: 54.99,
    ownedQuantity: 0,
  }),
  card({
    cardId: 'tcgp-sealed-2',
    name: 'Delta Reign Booster Box',
    cardNumber: '',
    productKind: 'sealed',
    sealedProductType: 'Booster Box',
    marketPrice: 160,
    ownedQuantity: 1,
  }),
];

function mockSet({ sealed = [] as CatalogSearchResult[] } = {}) {
  jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([SET]);
  const listCards = jest.spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion').mockResolvedValue(CARDS);
  const listSealed = jest.spyOn(MockSpotlightRepository.prototype, 'listSealedInExpansion').mockResolvedValue(sealed);
  jest.spyOn(MockSpotlightRepository.prototype, 'getInventoryEntries').mockResolvedValue(ENTRIES);
  return { listCards, listSealed };
}

/** Render-order position of a testID in the tree. */
function positionOf(testID: string): number {
  type Node = { props?: { testID?: unknown }; children?: unknown[] | null };
  const order: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const { props, children } = node as Node;
    order.push(props?.testID);
    (children ?? []).forEach(walk);
  };
  walk(screen.toJSON());
  return order.indexOf(testID);
}

async function renderSet() {
  renderWithProviders(
    <ExpansionDetailScreen expansionId="dri" expansionName="Delta Reign" game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} />,
  );
  await screen.findByTestId('set-card-gengar');
  await screen.findByText('TOTAL VALUE: $1,012.78');
}

function qty(cardId: string) {
  return screen.getByTestId(`set-card-${cardId}-stepper-value`).props.children;
}

describe('ExpansionDetailScreen (set page)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the whole set in one call and shows the header progress and full-set value', async () => {
    const { listCards } = mockSet();
    await renderSet();

    expect(listCards).toHaveBeenCalledWith('dri', '', 1000, 'pokemon');
    const header = screen.getByTestId('set-page-header');
    // Figma 6597:3931: name as written, date, a 20pt bar, value + "X of Y CARDS" (no percent text).
    expect(within(header).getByText('Delta Reign')).toBeTruthy();
    expect(within(header).getByText('5/22/2026')).toBeTruthy();
    expect(within(header).getByText('2 of 3 CARDS')).toBeTruthy();
    expect(within(header).queryByText('67%')).toBeNull();
    const bar = screen.getByTestId('set-page-header-progress');
    expect(bar.props.accessibilityLabel).toBe('67% complete');
    expect(StyleSheet.flatten(bar.props.style)).toMatchObject({ height: 20, borderRadius: 8 });
    expect(screen.getByText('#121/120')).toBeTruthy();
    // Price under the number, USD; an unpriced card has no price line.
    expect(screen.getByTestId('set-card-gengar-price').props.children).toBe('$1.50');
    expect(screen.queryByTestId('set-card-mew-price')).toBeNull();
  });

  it('draws unowned cards in full colour and marks owned ones with a purple checkbox on the art', async () => {
    mockSet();
    await renderSet();

    const opacityOf = (cardId: string) => StyleSheet.flatten(screen.getByTestId(`set-card-${cardId}-open`).props.style).opacity;
    expect(opacityOf('mew')).toBe(1);
    expect(opacityOf('gengar')).toBe(1);
    expect(screen.queryByText(/missing/i)).toBeNull();
    // Unowned: no marker. Any owned count: the same checked box (the stepper says how many).
    expect(screen.queryByTestId('set-card-mew-owned')).toBeNull();
    expect(screen.getByTestId('set-card-gengar-owned-check')).toBeTruthy();
    const lugiaBadge = screen.getByTestId('set-card-lugia-owned');
    expect(within(lugiaBadge).getByTestId('set-card-lugia-owned-check')).toBeTruthy();
    expect(lugiaBadge.props.accessibilityLabel).toBe('Owned 2');
    // The marker sits on the art, not over the name: primary purple, white ring.
    const gengarBadge = screen.getByTestId('set-card-gengar-owned');
    expect(within(gengarBadge).queryByText('Gengar')).toBeNull();
    expect(gengarBadge.props.accessibilityState).toMatchObject({ checked: true });
    expect(StyleSheet.flatten(gengarBadge.props.style)).toMatchObject({
      backgroundColor: '#7000FF',
      borderColor: '#FFFFFF',
      borderCurve: 'continuous',
      position: 'absolute',
    });
    // Unowned reads "QTY: 0": − is off at zero; + is always on.
    expect(qty('mew')).toBe('QTY: 0');
    expect(screen.getByTestId('set-card-mew-stepper-decrement').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByTestId('set-card-mew-stepper-increment').props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('shares the set from the toolbar beside Back', async () => {
    mockSet();
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await renderSet();

    expect(screen.getByTestId('set-page-back')).toBeTruthy();
    fireEvent.press(screen.getByTestId('set-page-share'));
    expect(share).toHaveBeenCalledWith({ message: 'Delta Reign on Ekalight\nI have 2 of 3 cards' });
  });

  it('shows ALL plus only the rarity chips this set has, and filters by them', async () => {
    mockSet();
    await renderSet();

    expect(screen.getByTestId('set-page-rarity-all')).toBeTruthy();
    expect(screen.getByText('HR')).toBeTruthy();
    expect(screen.getByText('ULTRA RARE')).toBeTruthy();
    expect(screen.queryByText('SIR')).toBeNull();
    expect(screen.queryByText('IR')).toBeNull();
    expect(screen.queryByTestId('set-page-rarity-standard')).toBeNull();

    fireEvent.press(screen.getByTestId('set-page-rarity-secret'));
    expect(screen.getByTestId('set-card-mew')).toBeTruthy();
    expect(screen.queryByTestId('set-card-gengar')).toBeNull();
  });

  it('+ adds one NM raw copy optimistically through the existing create call', async () => {
    mockSet();
    let resolveCreate: (value: InventoryEntryCreateResponsePayload) => void = () => undefined;
    const create = jest.spyOn(MockSpotlightRepository.prototype, 'createInventoryEntry').mockImplementation(
      () => new Promise((resolve) => {
        resolveCreate = resolve as (value: InventoryEntryCreateResponsePayload) => void;
      }),
    );
    await renderSet();

    fireEvent.press(screen.getByTestId('set-card-mew-stepper-increment'));

    // Tile and header move before the server answers.
    expect(qty('mew')).toBe('QTY: 1');
    expect(screen.getByText('3 of 3 CARDS')).toBeTruthy();
    expect(screen.getByTestId('set-page-header-progress').props.accessibilityLabel).toBe('100% complete');
    expect(screen.getByTestId('set-card-mew-owned-check')).toBeTruthy();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      cardID: 'mew',
      condition: 'near_mint',
      quantity: 1,
      slabContext: null,
      sourceScanID: null,
    }));

    await act(async () => {
      resolveCreate({
        deckEntryID: 'e-mew',
        cardID: 'mew',
        variantName: null,
        condition: 'near_mint',
        confirmationID: null,
        sourceScanID: null,
        addedAt: '2026-11-20T00:00:00.000Z',
      });
    });
    expect(qty('mew')).toBe('QTY: 1');
  });

  it('has no SEALED chip or section when the set has no sealed products', async () => {
    const { listSealed } = mockSet();
    await renderSet();

    expect(listSealed).toHaveBeenCalledWith('dri', 'pokemon');
    expect(screen.queryByTestId('set-page-sealed-chip')).toBeNull();
    expect(screen.queryByTestId('set-page-sealed-heading')).toBeNull();
  });

  it('ALL lists every card first, then the sealed products under SEALED at the bottom', async () => {
    mockSet({ sealed: SEALED });
    await renderSet();

    const chip = await screen.findByTestId('set-page-sealed-chip');
    expect(within(chip).getByText('SEALED')).toBeTruthy();
    // Right after ALL, before the rarity chips.
    expect(positionOf('set-page-rarity-all')).toBeLessThan(positionOf('set-page-sealed-chip'));
    expect(positionOf('set-page-sealed-chip')).toBeLessThan(positionOf('set-page-rarity-secret'));

    const heading = positionOf('set-page-sealed-heading');
    expect(heading).toBeGreaterThan(-1);
    for (const cardId of ['gengar', 'lugia', 'mew']) {
      expect(positionOf(`set-card-${cardId}`)).toBeLessThan(heading);
    }
    expect(positionOf('set-card-tcgp-sealed-1')).toBeGreaterThan(heading);
    expect(positionOf('set-card-tcgp-sealed-2')).toBeGreaterThan(heading);
    // Sealed tile: name, product type, USD price; owned one carries the marker.
    expect(screen.getByText('Elite Trainer Box')).toBeTruthy();
    expect(screen.getByTestId('set-card-tcgp-sealed-1-price').props.children).toBe('$54.99');
    expect(screen.getByTestId('set-card-tcgp-sealed-2-owned-check')).toBeTruthy();
    // Owning sealed never moves the set's completion.
    expect(screen.getByText('2 of 3 CARDS')).toBeTruthy();
  });

  it('SEALED shows only the set\'s sealed products', async () => {
    mockSet({ sealed: SEALED });
    await renderSet();

    fireEvent.press(await screen.findByTestId('set-page-sealed-chip'));

    expect(screen.getByTestId('set-card-tcgp-sealed-1')).toBeTruthy();
    expect(screen.getByTestId('set-card-tcgp-sealed-2')).toBeTruthy();
    expect(screen.queryByTestId('set-card-gengar')).toBeNull();
    expect(screen.queryByTestId('set-page-sealed-heading')).toBeNull();

    // A rarity chip hides sealed again.
    fireEvent.press(screen.getByTestId('set-page-rarity-ultra'));
    expect(screen.getByTestId('set-card-lugia')).toBeTruthy();
    expect(screen.queryByTestId('set-card-tcgp-sealed-1')).toBeNull();
  });

  it('+ on a sealed product adds one unopened copy (no printing, no condition)', async () => {
    mockSet({ sealed: SEALED });
    const create = jest.spyOn(MockSpotlightRepository.prototype, 'createInventoryEntry').mockResolvedValue({
      deckEntryID: 'e-etb',
      cardID: 'tcgp-sealed-1',
      variantName: null,
      condition: null,
      confirmationID: null,
      sourceScanID: null,
      addedAt: '2026-11-20T00:00:00.000Z',
    });
    await renderSet();

    fireEvent.press(await screen.findByTestId('set-card-tcgp-sealed-1-stepper-increment'));

    expect(qty('tcgp-sealed-1')).toBe('QTY: 1');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      cardID: 'tcgp-sealed-1',
      condition: null,
      variantName: null,
      quantity: 1,
    }));
    expect(screen.getByText('2 of 3 CARDS')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('set-card-tcgp-sealed-1-owned-check')).toBeTruthy());
  });

  it('+ rolls back with a toast when the add fails', async () => {
    mockSet();
    jest.spyOn(MockSpotlightRepository.prototype, 'createInventoryEntry').mockRejectedValue(new Error('offline'));
    await renderSet();

    fireEvent.press(screen.getByTestId('set-card-mew-stepper-increment'));

    expect(await screen.findByText("Couldn't add Mew. Try again.")).toBeTruthy();
    expect(qty('mew')).toBe('QTY: 0');
    expect(screen.getByText('2 of 3 CARDS')).toBeTruthy();
  });

  it('− on a card owned in one form removes that copy directly', async () => {
    mockSet();
    const remove = jest.spyOn(MockSpotlightRepository.prototype, 'deletePortfolioEntry')
      .mockResolvedValue({ deckEntryID: 'e-gengar', cardID: 'gengar' });
    await renderSet();

    fireEvent.press(screen.getByTestId('set-card-gengar-stepper-decrement'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith({ deckEntryID: 'e-gengar' }));
    expect(qty('gengar')).toBe('QTY: 0');
    expect(screen.queryByTestId('owned-copies-sheet')).toBeNull();
    expect(screen.getByText('1 of 3 CARDS')).toBeTruthy();
  });

  it('− on a card owned in more than one form asks which copy', async () => {
    mockSet();
    const remove = jest.spyOn(MockSpotlightRepository.prototype, 'deletePortfolioEntry')
      .mockResolvedValue({ deckEntryID: 'e-lugia-psa', cardID: 'lugia' });
    const setQuantity = jest.spyOn(MockSpotlightRepository.prototype, 'setPortfolioEntryQuantity');
    await renderSet();

    fireEvent.press(screen.getByTestId('set-card-lugia-stepper-decrement'));

    const sheet = await screen.findByTestId('owned-copies-sheet');
    expect(within(sheet).getByText('Normal · Near Mint')).toBeTruthy();
    expect(within(sheet).getByText('PSA 10')).toBeTruthy();
    // Nothing is removed until a copy is picked.
    expect(remove).not.toHaveBeenCalled();
    expect(qty('lugia')).toBe('QTY: 2');

    fireEvent.press(screen.getByTestId('owned-copies-sheet-row-e-lugia-psa'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith({ deckEntryID: 'e-lugia-psa' }));
    expect(setQuantity).not.toHaveBeenCalled();
    expect(qty('lugia')).toBe('QTY: 1');
  });
});

describe('pickSetPageAccent', () => {
  it("takes the logo's dominant colour first", () => {
    // iOS: `background` is the most frequent opaque logo colour.
    expect(
      pickSetPageAccent({ platform: 'ios', background: '#f5ef31', primary: '#710101', secondary: '#E53935' }),
    ).toBe('#F5EF31');
    // Android: `dominant` beats `vibrant`.
    expect(pickSetPageAccent({ platform: 'android', dominant: '#3A7BD5', vibrant: '#FFB005' })).toBe('#3A7BD5');
  });

  it('skips near-black, near-white and gray candidates for the next one', () => {
    // Black outline majority → the contrasting colour.
    expect(pickSetPageAccent({ platform: 'ios', background: '#000000', primary: '#6FC2EA' })).toBe('#6FC2EA');
    expect(pickSetPageAccent({ platform: 'ios', background: '#2E113B', primary: '#E18732' })).toBe('#E18732');
    expect(pickSetPageAccent({ platform: 'ios', background: '#FAFAFA', primary: '#101010', secondary: '#E53935' })).toBe(
      '#E53935',
    );
    expect(pickSetPageAccent({ platform: 'android', dominant: '#B3B3B2', vibrant: '#D81B60' })).toBe('#D81B60');
  });

  it('never reads Android `average` (it blends in the transparent canvas)', () => {
    expect(pickSetPageAccent({ platform: 'android', dominant: '#000000', average: '#7A5C2E' })).toBeNull();
  });

  it('is null when no colour can carry the wash', () => {
    // The native "couldn't read it" fallback is pure black.
    expect(
      pickSetPageAccent({ platform: 'ios', background: '#000000', primary: '#000000', secondary: '#000000', detail: '#000000' }),
    ).toBeNull();
    expect(pickSetPageAccent({ platform: 'ios', background: '#B3B3B2', primary: '#FFFFFF' })).toBeNull();
    expect(pickSetPageAccent({ vibrant: 'transparent' })).toBeNull();
    expect(pickSetPageAccent(null)).toBeNull();
  });
});
