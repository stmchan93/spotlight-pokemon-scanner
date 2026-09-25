import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { ScanPriceSheetSelection } from './screens/scan-price-sheet';
import {
  resolveCaptureTrayPrice,
  summarizeTrayPrices,
  type ScanTrayPrice,
  type TrayPriceSummary,
} from './screens/scanner-screen-helpers';
import type { RecentCapture } from './screens/scanner-screen-types';

/*
  The scan tray's rows + price picks, outside React state. A row subscribes to
  its own id, so patching one capture re-renders one row; the screen subscribes
  only to the id list and the few derived values it draws (count, TOTAL, …).
  One store per scanner-screen instance (the screen remounts on account change).
*/

export type TrayPriceSelections = ReadonlyMap<string, ScanPriceSheetSelection>;

export type TrayState = {
  /** Newest first, exactly the array persistence and the old `recentCaptures` held. */
  items: RecentCapture[];
  /** Same order as `items`; identity only changes when the order/membership does. */
  ids: readonly string[];
  byId: ReadonlyMap<string, RecentCapture>;
  priceSelections: TrayPriceSelections;
};

type Listener = () => void;
type Updater<T> = T | ((current: T) => T);

export type TrayStore = {
  getState: () => TrayState;
  subscribe: (listener: Listener) => () => void;
  /** Fires only when this id's capture or price selection changes identity. */
  subscribeId: (id: string, listener: Listener) => () => void;
  /** `setState` semantics: returning the same array is a no-op. */
  setItems: (next: Updater<RecentCapture[]>) => void;
  setPriceSelections: (next: Updater<TrayPriceSelections>) => void;
  /** `items.map(c => c.id === id ? transform(c) : c)` — always a new array, like the old updater. */
  patchCapture: (id: string, transform: (capture: RecentCapture) => RecentCapture) => void;
  /** Drops rows and their price picks in one emit. Returns the removed rows. */
  removeCaptures: (ids: ReadonlySet<string>) => RecentCapture[];
  /** Empties rows and price picks. Returns the rows that were there. */
  clear: () => RecentCapture[];
};

const emptySelections: TrayPriceSelections = new Map();

function sameIds(a: readonly string[], b: RecentCapture[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index].id) {
      return false;
    }
  }
  return true;
}

export function createTrayStore(
  initialItems: RecentCapture[] = [],
  initialSelections: TrayPriceSelections = emptySelections,
): TrayStore {
  let state: TrayState = {
    byId: new Map(initialItems.map((capture) => [capture.id, capture])),
    ids: initialItems.map((capture) => capture.id),
    items: initialItems,
    priceSelections: initialSelections,
  };
  const listeners = new Set<Listener>();
  const idListeners = new Map<string, Set<Listener>>();

  const emit = (changedIds: Set<string>) => {
    changedIds.forEach((id) => {
      idListeners.get(id)?.forEach((listener) => listener());
    });
    listeners.forEach((listener) => listener());
  };

  const commit = (nextItems: RecentCapture[], nextSelections: TrayPriceSelections) => {
    const previous = state;
    if (nextItems === previous.items && nextSelections === previous.priceSelections) {
      return;
    }
    const changedIds = new Set<string>();
    let byId = previous.byId;
    let ids = previous.ids;
    if (nextItems !== previous.items) {
      const nextById = new Map<string, RecentCapture>();
      nextItems.forEach((capture) => {
        nextById.set(capture.id, capture);
        if (previous.byId.get(capture.id) !== capture) {
          changedIds.add(capture.id);
        }
      });
      previous.byId.forEach((_, id) => {
        if (!nextById.has(id)) {
          changedIds.add(id);
        }
      });
      byId = nextById;
      ids = sameIds(previous.ids, nextItems) ? previous.ids : nextItems.map((capture) => capture.id);
    }
    if (nextSelections !== previous.priceSelections) {
      nextSelections.forEach((selection, id) => {
        if (previous.priceSelections.get(id) !== selection) {
          changedIds.add(id);
        }
      });
      previous.priceSelections.forEach((_, id) => {
        if (!nextSelections.has(id)) {
          changedIds.add(id);
        }
      });
    }
    state = { byId, ids, items: nextItems, priceSelections: nextSelections };
    emit(changedIds);
  };

  const withoutSelections = (ids: ReadonlySet<string>): TrayPriceSelections => {
    const current = state.priceSelections;
    if (![...ids].some((id) => current.has(id))) {
      return current;
    }
    const next = new Map(current);
    ids.forEach((id) => next.delete(id));
    return next;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeId: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        const current = idListeners.get(id);
        current?.delete(listener);
        if (current && current.size === 0) {
          idListeners.delete(id);
        }
      };
    },
    setItems: (next) => {
      const nextItems = typeof next === 'function' ? next(state.items) : next;
      commit(nextItems, state.priceSelections);
    },
    setPriceSelections: (next) => {
      const nextSelections = typeof next === 'function' ? next(state.priceSelections) : next;
      commit(state.items, nextSelections);
    },
    patchCapture: (id, transform) => {
      commit(
        state.items.map((capture) => (capture.id === id ? transform(capture) : capture)),
        state.priceSelections,
      );
    },
    removeCaptures: (ids) => {
      const removed = state.items.filter((capture) => ids.has(capture.id));
      commit(state.items.filter((capture) => !ids.has(capture.id)), withoutSelections(ids));
      return removed;
    },
    clear: () => {
      const removed = state.items;
      commit([], new Map());
      return removed;
    },
  };
}

// --- Derived values ---

// Per-row price memo: a row's resolved price only changes with its capture
// object or its selection, so the TOTAL re-resolves just the rows that changed.
// The sum itself is still one ordered pass through `summarizeTrayPrices`, so it
// is bit-identical to the full recompute (running +/- deltas would drift).
const trayPriceCache = new WeakMap<
  RecentCapture,
  { selection: ScanPriceSheetSelection | null; price: ScanTrayPrice }
>();

export function cachedCaptureTrayPrice(
  capture: RecentCapture,
  selection: ScanPriceSheetSelection | null,
): ScanTrayPrice {
  const cached = trayPriceCache.get(capture);
  if (cached && cached.selection === selection) {
    return cached.price;
  }
  const price = resolveCaptureTrayPrice(capture, selection);
  trayPriceCache.set(capture, { price, selection });
  return price;
}

export function selectTrayPriceSummary(state: TrayState): TrayPriceSummary {
  return summarizeTrayPrices(state.items.map(
    (capture) => cachedCaptureTrayPrice(capture, state.priceSelections.get(capture.id) ?? null),
  ));
}

export function trayPriceSummaryEqual(a: TrayPriceSummary, b: TrayPriceSummary): boolean {
  return a.total === b.total
    && a.currencyCode === b.currencyCode
    && shallowArrayEqual(a.unsupportedCurrencyCodes, b.unsupportedCurrencyCodes);
}

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) {
      return false;
    }
  }
  return true;
}

// --- Hooks ---

export function useTraySelector<T>(
  store: TrayStore,
  selector: (state: TrayState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // Memoized on (state, selector) and held across equal results, so an
  // unrelated tray change returns the previous value and React bails out.
  const cacheRef = useRef<{ selector: (state: TrayState) => T; state: TrayState; value: T } | null>(null);
  const getSnapshot = () => {
    const state = store.getState();
    const cached = cacheRef.current;
    if (cached && cached.state === state && cached.selector === selector) {
      return cached.value;
    }
    const next = selector(state);
    const value = cached && isEqual(cached.value, next) ? cached.value : next;
    cacheRef.current = { selector, state, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useTrayIds(store: TrayStore): readonly string[] {
  return useSyncExternalStore(store.subscribe, () => store.getState().ids, () => store.getState().ids);
}

function useIdSubscription(store: TrayStore, id: string | null) {
  return useCallback(
    (listener: Listener) => (id == null ? () => {} : store.subscribeId(id, listener)),
    [id, store],
  );
}

export function useTrayCapture(store: TrayStore, id: string | null): RecentCapture | null {
  const subscribe = useIdSubscription(store, id);
  const get = () => (id == null ? null : store.getState().byId.get(id) ?? null);
  return useSyncExternalStore(subscribe, get, get);
}

export function useTrayPriceSelection(store: TrayStore, id: string | null): ScanPriceSheetSelection | null {
  const subscribe = useIdSubscription(store, id);
  const get = () => (id == null ? null : store.getState().priceSelections.get(id) ?? null);
  return useSyncExternalStore(subscribe, get, get);
}

export function useTrayPriceSummary(store: TrayStore): TrayPriceSummary {
  return useTraySelector(store, selectTrayPriceSummary, trayPriceSummaryEqual);
}
