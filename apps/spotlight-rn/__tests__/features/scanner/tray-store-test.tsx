import { act, render } from '@testing-library/react-native';
import { memo } from 'react';
import { Text } from 'react-native';

import type { ScanPriceSheetSelection } from '@/features/scanner/screens/scan-price-sheet';
import {
  resolveCaptureTrayPrice,
  summarizeTrayPrices,
} from '@/features/scanner/screens/scanner-screen-helpers';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import {
  createTrayStore,
  selectTrayPriceSummary,
  useTrayCapture,
  useTrayIds,
  useTrayPriceSelection,
  useTrayPriceSummary,
  type TrayState,
  type TrayStore,
} from '@/features/scanner/tray-store';

function makeCapture(id: string, overrides: Partial<RecentCapture> = {}): RecentCapture {
  return {
    activeCandidateIndex: 0,
    candidates: [
      { cardId: `${id}-a`, currencyCode: 'USD', marketPrice: 10 },
      { cardId: `${id}-b`, currencyCode: 'USD', marketPrice: 3.33 },
    ] as RecentCapture['candidates'],
    hasTrackedSelectionEvent: false,
    id,
    isAddingToInventory: false,
    isLoadingCandidates: false,
    isLoadingMoreCandidates: false,
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    normalizedImageUri: null,
    recentlyAdded: false,
    scanID: `scan-${id}`,
    shownAtMs: 1_000,
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    totalCandidateCount: 2,
    uri: `file://${id}.jpg`,
    ...overrides,
  } as RecentCapture;
}

function makeSelection(marketPrice: number | null): ScanPriceSheetSelection {
  return {
    conditionCode: 'near_mint',
    conditionShortLabel: 'NM',
    marketPrice,
    variantKey: 'holofoil',
    variantLabel: 'Holofoil',
  } as ScanPriceSheetSelection;
}

// The pre-store computation the screen used to run on every tray change.
function fullRecomputeSummary(state: TrayState) {
  return summarizeTrayPrices(state.items.map(
    (capture) => resolveCaptureTrayPrice(capture, state.priceSelections.get(capture.id) ?? null),
  ));
}

describe('tray store', () => {
  it('keeps ids, byId and items in step through insert / patch / remove / clear', () => {
    const store = createTrayStore();
    store.setItems((current) => [makeCapture('a'), ...current]);
    store.setItems((current) => [makeCapture('b'), makeCapture('c'), ...current]);
    expect(store.getState().ids).toEqual(['b', 'c', 'a']);
    expect(store.getState().byId.get('c')?.id).toBe('c');

    const idsBefore = store.getState().ids;
    const untouched = store.getState().byId.get('a');
    store.patchCapture('b', (capture) => ({ ...capture, isLoadingCandidates: true }));
    // Same order → same ids array, so the list does not re-render.
    expect(store.getState().ids).toBe(idsBefore);
    expect(store.getState().byId.get('b')?.isLoadingCandidates).toBe(true);
    expect(store.getState().byId.get('a')).toBe(untouched);

    store.setPriceSelections(new Map([['c', makeSelection(5)], ['a', makeSelection(1)]]));
    const removed = store.removeCaptures(new Set(['c']));
    expect(removed.map((capture) => capture.id)).toEqual(['c']);
    expect(store.getState().ids).toEqual(['b', 'a']);
    // A removed row takes its price pick with it; others keep theirs.
    expect(store.getState().priceSelections.has('c')).toBe(false);
    expect(store.getState().priceSelections.get('a')?.marketPrice).toBe(1);

    const cleared = store.clear();
    expect(cleared.map((capture) => capture.id)).toEqual(['b', 'a']);
    expect(store.getState().items).toEqual([]);
    expect(store.getState().priceSelections.size).toBe(0);
  });

  it('mirrors setState: a same-array updater is a no-op, patchCapture always yields a new array', () => {
    const store = createTrayStore([makeCapture('a')]);
    const listener = jest.fn();
    store.subscribe(listener);

    const before = store.getState();
    store.setItems((current) => current);
    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    // Like the old `current.map(...)` updater: new array even for an unknown id.
    store.patchCapture('missing', (capture) => capture);
    expect(store.getState().items).not.toBe(before.items);
    expect(store.getState().items).toEqual(before.items);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies an id only when that row or its price pick changes', () => {
    const store = createTrayStore([makeCapture('a'), makeCapture('b')]);
    const onA = jest.fn();
    const onB = jest.fn();
    store.subscribeId('a', onA);
    const unsubscribeB = store.subscribeId('b', onB);

    store.patchCapture('a', (capture) => ({ ...capture, recentlyAdded: true }));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();

    store.setPriceSelections((current) => new Map(current).set('b', makeSelection(2)));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);

    store.removeCaptures(new Set(['b']));
    expect(onB).toHaveBeenCalledTimes(2);

    unsubscribeB();
    store.setItems((current) => [makeCapture('b'), ...current]);
    expect(onB).toHaveBeenCalledTimes(2);
  });

  it('computes the TOTAL exactly like the old full recompute through patches and picks', () => {
    const store = createTrayStore();
    const prices = [0.1, 0.2, 0.3, 19.99, 1234.56, 7.07, 0.01, 99.95];
    store.setItems(prices.map((price, index) => makeCapture(`c${index}`, {
      candidates: [
        { cardId: `card-${index}`, currencyCode: index === 5 ? 'JPY' : 'USD', marketPrice: price },
        { cardId: `alt-${index}`, currencyCode: 'USD', marketPrice: price / 3 },
      ] as RecentCapture['candidates'],
    })));
    const check = () => {
      const state = store.getState();
      expect(selectTrayPriceSummary(state)).toEqual(fullRecomputeSummary(state));
    };
    check();
    store.patchCapture('c2', (capture) => ({ ...capture, activeCandidateIndex: 1 }));
    check();
    store.setPriceSelections(new Map([['c3', makeSelection(12.34)], ['c4', makeSelection(null)]]));
    check();
    store.patchCapture('c3', (capture) => ({ ...capture, isLoadingCandidates: true }));
    check();
    store.setPriceSelections((current) => new Map(current).set('c3', makeSelection(0.07)));
    check();
    store.removeCaptures(new Set(['c0', 'c5']));
    check();
    store.setItems((current) => [makeCapture('new', { candidates: [] }), ...current]);
    check();
    expect(selectTrayPriceSummary(store.getState()).unsupportedCurrencyCodes).toEqual([]);
  });
});

describe('tray store hooks', () => {
  const renders = new Map<string, number>();
  let listRenders = 0;

  const Row = memo(function Row({ id, store }: { id: string; store: TrayStore }) {
    const capture = useTrayCapture(store, id);
    const selection = useTrayPriceSelection(store, id);
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return (
      <Text testID={`row-${id}`}>
        {`${capture?.recentlyAdded ? 'added' : 'open'}:${selection?.marketPrice ?? '-'}`}
      </Text>
    );
  });

  function List({ store }: { store: TrayStore }) {
    const ids = useTrayIds(store);
    const summary = useTrayPriceSummary(store);
    listRenders += 1;
    return (
      <>
        <Text testID="total">{String(summary.total)}</Text>
        {ids.map((id) => <Row id={id} key={id} store={store} />)}
      </>
    );
  }

  beforeEach(() => {
    renders.clear();
    listRenders = 0;
  });

  it('re-renders only the patched row, and the list only when ids or the total change', () => {
    const store = createTrayStore(['a', 'b', 'c'].map((id) => makeCapture(id)));
    const view = render(<List store={store} />);
    expect(listRenders).toBe(1);
    expect(Object.fromEntries(renders)).toEqual({ a: 1, b: 1, c: 1 });

    // A field the list does not draw: one row re-renders, the list does not.
    act(() => {
      store.patchCapture('b', (capture) => ({ ...capture, recentlyAdded: true }));
    });
    expect(view.getByTestId('row-b').props.children).toBe('added:-');
    expect(Object.fromEntries(renders)).toEqual({ a: 1, b: 2, c: 1 });
    expect(listRenders).toBe(1);

    // A price pick: that row + the list (its TOTAL changed); siblings stay put.
    act(() => {
      store.setPriceSelections(new Map([['c', makeSelection(1)]]));
    });
    expect(view.getByTestId('row-c').props.children).toBe('open:1');
    expect(view.getByTestId('total').props.children).toBe('21');
    expect(Object.fromEntries(renders)).toEqual({ a: 1, b: 2, c: 2 });
    expect(listRenders).toBe(2);

    // A new row: the list re-renders, existing rows bail out of their memo.
    act(() => {
      store.setItems((current) => [makeCapture('d'), ...current]);
    });
    expect(listRenders).toBe(3);
    expect(Object.fromEntries(renders)).toEqual({ a: 1, b: 2, c: 2, d: 1 });
  });
});
