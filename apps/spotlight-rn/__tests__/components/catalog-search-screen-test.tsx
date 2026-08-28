import { act, fireEvent, screen } from '@testing-library/react-native';
import { Keyboard, StyleSheet } from 'react-native';

import {
  MockSpotlightRepository,
  mockCatalogResults,
} from '@spotlight/api-client';

import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';

import { noteCardAdded, clearCardAddedNotice } from '@/features/cards/card-added-notice';

import { renderWithProviders } from '../test-utils';

/*
  The screen reads the "Added to your collection" handoff on FOCUS, and
  `useFocusEffect` needs a real navigation container — these tests render the
  screen on its own, with no navigator above it. Running the callback once on
  mount is the right stand-in: a screen that has just been rendered here IS the
  focused one, and it keeps every existing test in this file navigator-free.
*/
jest.mock('expo-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useFocusEffect: (callback: () => void | (() => void)) => require('react').useEffect(callback, [callback]),
}));

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
  });
}

const ownedCatalogResults = mockCatalogResults.map((result) => ({
  ...result,
  ownedQuantity: result.ownedQuantity ?? 0,
}));

describe('CatalogSearchScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // No test here may inherit another's pending confirmation.
    clearCardAddedNotice();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the modal chrome, lists card matches directly, then opens a card', async () => {
    const onOpenCard = jest.fn();
    const onClose = jest.fn();
    let resolveSearch: ((page: Awaited<ReturnType<MockSpotlightRepository['searchCatalogCardsPage']>>) => void) | null = null;

    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockImplementation(() => {
      return new Promise((resolve) => {
        resolveSearch = resolve;
      });
    });

    renderWithProviders(
      <CatalogSearchScreen onClose={onClose} onOpenCard={onOpenCard} />,
    );

    expect(screen.getByText('Search Cards')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('catalog-header-back-row').props.style)).toMatchObject({
      alignSelf: 'flex-start',
    });

    fireEvent.press(screen.getByTestId('catalog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    expect(await screen.findByText('Searching catalog')).toBeTruthy();

    await act(async () => {
      resolveSearch?.({ cards: ownedCatalogResults, hasMore: false });
      await Promise.resolve();
    });

    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
    expect(screen.getByTestId('catalog-result-smoke-sm7-1')).toBeTruthy();
    expect(screen.getByTestId('catalog-result-sm7-2')).toBeTruthy();
    expect(screen.getByTestId('catalog-result-np-3')).toBeTruthy();
    expect(screen.queryByTestId('catalog-set-group-sm7-1')).toBeNull();

    fireEvent.press(screen.getByTestId('catalog-result-smoke-sm7-1'));
    expect(onOpenCard).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'sm7-1',
      name: 'Treecko',
    }));
  });

  it('shows the expansions browse grid when the box is empty and opens a set', async () => {
    const onSelectExpansion = jest.fn();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([
      { id: 'sv1', name: 'Scarlet & Violet', series: 'SV', code: 'sv1', releaseDate: '2023-03-31', imageUrl: '' },
      { id: 'sm7', name: 'Celestial Storm', series: 'SM', code: 'sm7', releaseDate: '2018-08-03', imageUrl: '' },
    ]);

    renderWithProviders(
      <CatalogSearchScreen
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={onSelectExpansion}
      />,
    );

    // No query typed → the expansions grid loads (logos + set names).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('catalog-expansion-sv1')).toBeTruthy();
    expect(screen.getByTestId('catalog-expansion-sm7')).toBeTruthy();
    // The set name is shown (rendered as the label, plus the no-image fallback).
    expect(screen.getAllByText('Scarlet & Violet').length).toBeGreaterThan(0);

    // Tapping a set drills into it; global card search still works by typing.
    fireEvent.press(screen.getByTestId('catalog-expansion-sv1'));
    expect(onSelectExpansion).toHaveBeenCalledWith(expect.objectContaining({ id: 'sv1' }));
  });

  it('searches cards only — no People segment and no collector results, however long the query', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    // The Cards/People `SegmentedControl` used to appear at exactly this point:
    // a text query of 2+ characters. Typing must now only ever search cards.
    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    expect(screen.queryByTestId('catalog-search-tabs')).toBeNull();
    expect(screen.queryByTestId('people-results-list')).toBeNull();
    expect(await screen.findByTestId('catalog-results-list')).toBeTruthy();
    // The rarity chips are no longer conditional on which lane is showing.
    expect(screen.getByTestId('catalog-rarity-chip-row')).toBeTruthy();
  });

  it('hydrates and searches from an initial query', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen initialQuery="tree" onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    await advanceDebounce();

    expect(screen.getByDisplayValue('tree')).toBeTruthy();
    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
  });

  it('clears the opening spinner after navigation starts so a returned result can be tapped again', async () => {
    const onOpenCard = jest.fn();
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={onOpenCard} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    const resultRow = await screen.findByTestId('catalog-result-smoke-sm7-1');
    fireEvent.press(resultRow);
    expect(onOpenCard).toHaveBeenCalledTimes(1);

    fireEvent.press(resultRow);
    expect(onOpenCard).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });

    fireEvent.press(resultRow);
    expect(onOpenCard).toHaveBeenCalledTimes(2);
  });

  it('renders the empty state when a query returns no matches', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: [], hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'zzz');
    await advanceDebounce();

    expect(await screen.findByText('No matching cards')).toBeTruthy();
    expect(screen.getByText('Try a shorter query, a different set name, or just the collector number.')).toBeTruthy();
  });

  it('appends the next page of results on scroll-to-end (infinite scroll)', async () => {
    const page1 = ownedCatalogResults.slice(0, 2);
    const page2 = ownedCatalogResults.slice(2, 4);
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValueOnce({ cards: page1, hasMore: true })
      .mockResolvedValueOnce({ cards: page2, hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    // Page 1 rendered; page 2 not yet.
    expect(await screen.findByTestId(`catalog-result-${page1[0].id}`)).toBeTruthy();
    expect(screen.queryByTestId(`catalog-result-${page2[0].id}`)).toBeNull();

    // Scroll to the end → page 2 fetched and appended (no duplicates).
    await act(async () => {
      fireEvent(screen.getByTestId('catalog-results-list'), 'endReached');
      await Promise.resolve();
    });

    expect(await screen.findByTestId(`catalog-result-${page2[0].id}`)).toBeTruthy();
    expect(screen.getByTestId(`catalog-result-${page1[0].id}`)).toBeTruthy();
  });

  it('shows the tile art placeholder when a result is missing an image', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
      cards: [
        {
          id: 'fallback-1',
          cardId: 'fallback-1',
          name: 'Fallback Card',
          cardNumber: '#999',
          setName: 'Parity Set',
          imageUrl: '',
          marketPrice: null,
          currencyCode: 'USD',
          ownedQuantity: 0,
        },
      ],
      hasMore: false,
    });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'fallback');
    await advanceDebounce();

    expect(await screen.findByTestId('catalog-result-fallback-1')).toBeTruthy();
    // The shared tile owns the no-image state: "CARD" placeholder, no Image.
    expect(screen.getByText('CARD')).toBeTruthy();
    expect(screen.queryByTestId('catalog-result-smoke-fallback-1-image')).toBeNull();
  });

  it('sends the rarityBucket option on a chip-only search (no text required)', async () => {
    const searchSpy = jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: ownedCatalogResults.slice(0, 1), hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    // Tap a rarity chip with the search box empty → browse-by-rarity search.
    fireEvent.press(screen.getByTestId('catalog-rarity-chip-sir'));
    await advanceDebounce();

    expect(searchSpy).toHaveBeenCalledWith('', expect.any(Number), 0, { rarityBucket: 'sir' });
    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();

    // Text + chip combine into one search request.
    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();
    expect(searchSpy).toHaveBeenCalledWith('tree', expect.any(Number), 0, { rarityBucket: 'sir' });

    // Tapping the active chip again clears it; with text present the next
    // search goes out without the rarity option.
    fireEvent.press(screen.getByTestId('catalog-rarity-chip-sir'));
    await advanceDebounce();
    expect(searchSpy).toHaveBeenCalledWith('tree', expect.any(Number), 0, undefined);
  });

  it('never shows a per-row rarity tag, whatever the payload carries', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
      cards: [ownedCatalogResults[0], { ...ownedCatalogResults[3], rarityBucket: undefined }],
      hasMore: false,
    });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    /*
      Rows USED to append the bucket label ("Full Art", "Secret", …) beside the
      set name. With the rarity chips right above the results the per-row copy
      restated the filter, so it was removed — for every bucket, not just the
      chip-less ones.
    */
    await screen.findByTestId('catalog-result-sm7-1');
    expect(screen.queryByTestId('catalog-result-rarity-sm7-1')).toBeNull();
  });

  describe('the two-column results grid', () => {
    it('chunks results into rows of two shared tiles with the card-aspect art frame', async () => {
      jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
        .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
      await advanceDebounce();

      await screen.findByTestId('catalog-result-sm7-1');

      // 5 results → rows of [2, 2, 1] (chunk-rows-of-2, not numColumns).
      const rows = screen.getByTestId('catalog-results-list').props.data as unknown[][];
      expect(rows.map((row) => row.length)).toEqual([2, 2, 1]);

      // Every tile renders, not just one per row.
      for (const result of ownedCatalogResults) {
        expect(screen.getByTestId(`catalog-result-${result.id}`)).toBeTruthy();
      }

      // The art frame is the tile's 'card' aspect, not the square default.
      const frame = StyleSheet.flatten(
        screen.getByTestId('catalog-result-smoke-sm7-1-image-frame').props.style,
      );
      expect(frame.aspectRatio).toBeCloseTo(0.716);
    });

    it("uses the tile's quantity readout as the Owned signal, hidden at zero", async () => {
      jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
        cards: [
          { ...ownedCatalogResults[0], ownedQuantity: 3 },
          { ...ownedCatalogResults[1], ownedQuantity: 0 },
        ],
        hasMore: false,
      });

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
      await advanceDebounce();

      await screen.findByTestId('catalog-result-sm7-1');
      expect(screen.getByTestId('catalog-result-smoke-sm7-1-quantity')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
      expect(screen.queryByTestId('catalog-result-smoke-sm7-2-quantity')).toBeNull();
    });
  });

  it('surfaces the retry action after a failed search', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ cards: ownedCatalogResults.slice(0, 1), hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    expect(await screen.findByText('Search unavailable')).toBeTruthy();

    fireEvent.press(screen.getByTestId('catalog-retry'));
    await advanceDebounce();

    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
    // The tile joins number + set (leading # stripped by the shared primitive).
    expect(screen.getByText('001/096 · 裂空のカリスマ')).toBeTruthy();
  });

  /*
    Literals, because the number is the design: the chip row pays 16 below and the
    list under it used to add another 4, so the gap below the filters was 20 while
    above stayed 16. Chip SIZE is not asserted here — that is `PillButton`'s.
  */
  describe('the space around the rarity filters', () => {
    it('pays 16 above the chips and 16 below, with nothing added underneath', async () => {
      jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([
        { id: 'sv1', name: 'Scarlet & Violet', series: 'SV', code: 'sv1', releaseDate: '2023-03-31', imageUrl: '' },
      ]);

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const chipRow = StyleSheet.flatten(
        screen.getByTestId('catalog-rarity-chip-row').props.contentContainerStyle,
      );
      expect(chipRow.paddingVertical).toBe(16);

      // The grid must not top up that 16 — it is the whole gap.
      const grid = StyleSheet.flatten(
        screen.getByTestId('catalog-expansion-grid').props.contentContainerStyle,
      );
      expect(grid.paddingTop).toBe(0);
    });

    /*
      The chips shipped as full-height white columns: RN's horizontal ScrollView
      carries `flexGrow: 1`, and as a direct child of the `flex: 1` screen it took
      every remaining point. Both halves pinned — either alone hides the symptom.
    */
    it('keeps the chip row hugging its content instead of filling the screen', async () => {
      jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([]);

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      await act(async () => {
        await Promise.resolve();
      });

      const scroller = StyleSheet.flatten(
        screen.getByTestId('catalog-rarity-chip-row').props.style,
      );
      expect(scroller.flexGrow).toBe(0);

      // …and a chip is never sized by the row, whatever height the row has.
      const chipRow = StyleSheet.flatten(
        screen.getByTestId('catalog-rarity-chip-row').props.contentContainerStyle,
      );
      expect(chipRow.alignItems).toBe('center');
    });
  });

  /*
    Adding used to collapse the whole stack onto the tabs root — which is the feed
    now — so you had to reopen search for every card. Only the card page pops, and
    the toast carries the confirmation.
  */
  describe('the added-to-collection confirmation', () => {
    it('shows the notice the card page left behind on the way back', () => {
      noteCardAdded('Added to your collection');

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      expect(screen.getByTestId('catalog-added-toast')).toBeTruthy();
      expect(screen.getByText('Added to your collection')).toBeTruthy();
    });

    /*
      The search that led to the add is OVER. Returning with the old text still
      in the field kept the keyboard up, and the keyboard sat exactly where the
      toast renders — the confirmation was invisible behind it.
    */
    it('clears the query and drops the keyboard so the toast can be seen', () => {
      const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
      noteCardAdded('Added to your collection');

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      expect(
        screen.getByPlaceholderText('Search by name, set, or number').props.value,
      ).toBe('');
      expect(dismiss).toHaveBeenCalled();
      dismiss.mockRestore();
    });

    /*
      And the keyboard drops at DEPARTURE, while the field genuinely holds
      focus — the return-time dismiss above raced the pop transition's focus
      restore, so the keyboard came straight back after adding a card.
    */
    it('drops the keyboard the moment a result is opened', async () => {
      const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
      jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
        .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );
      fireEvent.changeText(
        screen.getByPlaceholderText('Search by name, set, or number'),
        'tree',
      );
      await advanceDebounce();

      fireEvent.press(await screen.findByTestId('catalog-result-sm7-1'));
      expect(dismiss).toHaveBeenCalled();
      dismiss.mockRestore();
    });

    it('stays silent when no card was added', () => {
      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      // The Toast renders nothing at all while invisible, so a search opened
      // normally must not carry a stale confirmation.
      expect(screen.queryByTestId('catalog-added-toast')).toBeNull();
    });

    it('does not resurrect a notice that was never read in time', () => {
      // Added somewhere that was not listening — the Collection, say — and only
      // now is search opened.
      noteCardAdded('Added to your collection', Date.now() - 60_000);

      renderWithProviders(
        <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
      );

      expect(screen.queryByTestId('catalog-added-toast')).toBeNull();
    });
  });
});
