import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  ChartMode,
  InventoryCardEntry,
  PortfolioDashboard,
  PortfolioChartPoint,
  PortfolioHistoryRange,
  RecentSaleRecord,
} from '@spotlight/api-client';

import { useTabsPage } from '@/contexts/tabs-page-context';
import { reflectInventoryCacheIntoDashboard } from '@/features/portfolio/optimistic-inventory';
import { persistDashboard, readPersistedDashboard } from '@/features/portfolio/persisted-dashboard';
import { prefetchCardImages } from '@/lib/card-images';
import {
  formatEditableSellPrice,
  parseSellPrice,
  sanitizeSellPriceText,
} from '@/lib/price-input';
import { useAppServices } from '@/providers/app-providers';

const maxRecentSales = 9;

const emptyPortfolioDashboard: PortfolioDashboard = {
  summary: {
    currentValue: 0,
    changeAmount: 0,
    changePercent: 0,
    asOfLabel: 'Today',
  },
  inventoryCount: 0,
  inventoryItems: [],
  recentSales: [],
  ranges: {
    '1W': { portfolio: [], sales: [] },
    '1M': { portfolio: [], sales: [] },
    '3M': { portfolio: [], sales: [] },
    YTD: { portfolio: [], sales: [] },
    '1Y': { portfolio: [], sales: [] },
    ALL: { portfolio: [], sales: [] },
  },
};

function calculateInventoryValue(entries: InventoryCardEntry[]) {
  return Number(entries.reduce((sum, entry) => {
    if (!entry.hasMarketPrice) {
      return sum;
    }

    return sum + Math.max(0, entry.marketPrice) * Math.max(0, entry.quantity);
  }, 0).toFixed(2));
}

function buildInventoryFallbackDashboard(entries: InventoryCardEntry[]): PortfolioDashboard {
  const currentValue = calculateInventoryValue(entries);

  return {
    ...emptyPortfolioDashboard,
    summary: {
      currentValue,
      changeAmount: 0,
      changePercent: 0,
      asOfLabel: 'Current snapshot',
    },
    inventoryCount: entries.length,
    inventoryItems: entries,
  };
}

function mergeDashboardInventory(
  dashboard: PortfolioDashboard,
  inventoryItems: InventoryCardEntry[],
): PortfolioDashboard {
  return {
    ...dashboard,
    inventoryCount: inventoryItems.length,
    inventoryItems,
  };
}

function dashboardHasHydratedSeries(dashboard: PortfolioDashboard) {
  return Object.values(dashboard.ranges).some((range) => {
    return range.portfolio.length > 0 || range.sales.length > 0;
  });
}

function inventorySearchText(item: InventoryCardEntry) {
  return [
    item.name,
    item.cardNumber,
    item.setName,
    item.conditionLabel,
    item.conditionShortLabel,
    item.variantName,
    item.slabContext?.grader,
    item.slabContext?.grade,
    item.slabContext?.variantName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function normalizeChartPointDate(isoDate: string) {
  return isoDate.includes('T') ? isoDate : `${isoDate}T12:00:00.000Z`;
}

function updateSalesSeriesForSalePrice(
  points: PortfolioChartPoint[],
  sale: RecentSaleRecord,
  priceDelta: number,
) {
  if (points.length === 0 || priceDelta === 0) {
    return points;
  }

  const saleTimestamp = Date.parse(sale.soldAtISO);
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  points.forEach((point, index) => {
    const pointTimestamp = Date.parse(normalizeChartPointDate(point.isoDate));
    const distance = Math.abs(pointTimestamp - saleTimestamp);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });

  return points.map((point, index) => {
    if (index !== closestIndex) {
      return point;
    }

    return {
      ...point,
      value: Math.max(0, Number((point.value + priceDelta).toFixed(2))),
    };
  });
}

function applySalePriceEdit(
  dashboard: PortfolioDashboard,
  saleId: string,
  nextSoldPrice: number,
) {
  const existingSale = dashboard.recentSales.find((sale) => sale.id === saleId);
  if (!existingSale || existingSale.kind !== 'sold') {
    return dashboard;
  }

  const priceDelta = Number((nextSoldPrice - existingSale.soldPrice).toFixed(2));
  if (priceDelta === 0) {
    return dashboard;
  }

  const recentSales = dashboard.recentSales.map((sale) => {
    if (sale.id !== saleId) {
      return sale;
    }

    return {
      ...sale,
      soldPrice: nextSoldPrice,
    };
  });

  return {
    ...dashboard,
    recentSales,
    ranges: {
      '1W': {
        ...dashboard.ranges['1W'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['1W'].sales, existingSale, priceDelta),
      },
      '1M': {
        ...dashboard.ranges['1M'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['1M'].sales, existingSale, priceDelta),
      },
      '3M': {
        ...dashboard.ranges['3M'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['3M'].sales, existingSale, priceDelta),
      },
      YTD: {
        ...dashboard.ranges.YTD,
        sales: updateSalesSeriesForSalePrice(dashboard.ranges.YTD.sales, existingSale, priceDelta),
      },
      '1Y': {
        ...dashboard.ranges['1Y'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['1Y'].sales, existingSale, priceDelta),
      },
      ALL: {
        ...dashboard.ranges.ALL,
        sales: updateSalesSeriesForSalePrice(dashboard.ranges.ALL.sales, existingSale, priceDelta),
      },
    },
  };
}

export function usePortfolioScreenModel() {
  const {
    spotlightRepository,
    dataVersion,
    sessionOwnerKey,
    inventoryEntriesCache,
    setInventoryEntriesCache,
    portfolioDashboardCache,
    setPortfolioDashboardCache,
  } = useAppServices();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dashboard, setDashboard] = useState<PortfolioDashboard>(
    () => portfolioDashboardCache
      ?? (inventoryEntriesCache ? buildInventoryFallbackDashboard(inventoryEntriesCache) : emptyPortfolioDashboard),
  );
  const [hasLoadedInventory, setHasLoadedInventory] = useState(inventoryEntriesCache !== null);
  const [hasLoadedDashboard, setHasLoadedDashboard] = useState(portfolioDashboardCache !== null);
  const [isLoadingInventory, setIsLoadingInventory] = useState(inventoryEntriesCache === null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(portfolioDashboardCache === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDashboardStale, setIsDashboardStale] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  // True once we have any dashboard worth showing (live, in-memory, or persisted)
  // — used to suppress the blocking error when we can keep showing the last chart.
  const hasUsableDashboardRef = useRef<boolean>(portfolioDashboardCache !== null);
  // Mirror the dashboard we're CURRENTLY showing into a ref so the async loaders
  // can compare against it without being re-created on every dashboard change.
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;
  const [selectedRange, setSelectedRange] = useState<PortfolioHistoryRange>('1W');
  // Open-range loading: the dashboard now computes only the open range; other
  // ranges are fetched on demand when the user switches to them. `loadingRange`
  // drives the chart skeleton during that fetch; `loadedRangesRef` tracks which
  // ranges are already populated so re-selecting them is instant.
  const [loadingRange, setLoadingRange] = useState<PortfolioHistoryRange | null>(null);
  const selectedRangeRef = useRef<PortfolioHistoryRange>(selectedRange);
  useEffect(() => {
    selectedRangeRef.current = selectedRange;
  }, [selectedRange]);
  const loadedRangesRef = useRef<Set<PortfolioHistoryRange>>(new Set<PortfolioHistoryRange>(['1W']));
  const [chartMode, setChartMode] = useState<ChartMode>('portfolio');
  const [inventoryExpanded, setInventoryExpanded] = useState(true);
  const [recentSalesExpanded, setRecentSalesExpanded] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const [editingSalePriceText, setEditingSalePriceText] = useState('');

  const loadInventory = useCallback(async () => {
    setIsLoadingInventory(true);
    const loadResult = await spotlightRepository.loadInventoryEntries();

    if (loadResult.data && loadResult.state !== 'error') {
      const inventoryItems = loadResult.data;

      setInventoryEntriesCache(inventoryItems);
      setHasLoadedInventory(true);
      setDashboard((currentDashboard) => {
        if (dashboardHasHydratedSeries(currentDashboard)) {
          return mergeDashboardInventory(currentDashboard, inventoryItems);
        }

        return buildInventoryFallbackDashboard(inventoryItems);
      });
    } else {
      setLoadError(loadResult.errorMessage);
    }

    setIsLoadingInventory(false);
  }, [setInventoryEntriesCache, spotlightRepository]);

  // On a cold launch with no in-memory cache, hydrate the last persisted
  // dashboard so the chart appears instantly; the live refresh below then
  // revalidates it. Runs once on mount.
  useEffect(() => {
    if (portfolioDashboardCache !== null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const persisted = await readPersistedDashboard(sessionOwnerKey);
      if (cancelled || hasUsableDashboardRef.current || !persisted) {
        return;
      }
      setDashboard(persisted.dashboard);
      setPortfolioDashboardCache(persisted.dashboard);
      setInventoryEntriesCache(persisted.dashboard.inventoryItems);
      setHasLoadedDashboard(true);
      setIsLoadingDashboard(false);
      setLastUpdatedAt(persisted.savedAt || null);
      hasUsableDashboardRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // mount-only hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDashboard = useCallback(async () => {
    setIsLoadingDashboard(true);
    // Compute only the open range; the rest are fetched on demand. Read it from a
    // ref so this callback isn't re-created on every range switch (which would
    // re-trigger the auto-refresh effect).
    const openRange = selectedRangeRef.current;
    const loadResult = await spotlightRepository.loadPortfolioDashboard({ range: openRange });

    // The backend returns state 'empty' only when it sees NO inventory AND NO
    // sales. For someone who already has a portfolio that's never legitimate — a
    // real "sold everything" still has sale records, so it comes back 'success'.
    // An 'empty' here means a transient read landed while the backend was busy
    // (e.g. right after rapid scans, which serialize backend work). Accepting it
    // would zero AND cache the value until an app restart, so treat it as a
    // failed refresh: keep the real value and let it revalidate.
    const current = dashboardRef.current;
    const currentlyHasValue = current.inventoryCount > 0 || current.summary.currentValue > 0;
    const isSuspiciousEmpty = loadResult.state === 'empty' && currentlyHasValue;

    if (loadResult.data && loadResult.state !== 'error' && !isSuspiciousEmpty) {
      const savedAt = new Date().toISOString();
      const nextDashboard = loadResult.data;
      // Inventory display is owned by the FAST path: loadInventory reads the
      // local DB (~1s) and the reflect effect applies optimistic add/edit/delete.
      // This consolidated dashboard load is SLOW (5-10s of network/compute), and
      // a full replace here clobbers that fast inventory back to whatever this
      // call happened to read — the "edit the grade on the PDP, Collection takes
      // 5-10s to update" bug. Keep the summary/chart/sales this call computes,
      // but keep the already-fresh inventory rows the fast path put on screen.
      // (loadDashboard always runs paired with loadInventory, so `current`
      // carries the fresh local-DB inventory by the time this lands.)
      setDashboard((current) => {
        const keepInventory =
          current.inventoryItems.length > 0 || dashboardHasHydratedSeries(current);
        return keepInventory
          ? {
              ...nextDashboard,
              inventoryCount: current.inventoryItems.length,
              inventoryItems: current.inventoryItems,
            }
          : nextDashboard;
      });
      // A fresh dashboard only carries the open range; drop any previously
      // on-demand-loaded ranges so a data change can't leave them stale.
      loadedRangesRef.current = new Set<PortfolioHistoryRange>([openRange]);
      setPortfolioDashboardCache(nextDashboard);
      setInventoryEntriesCache(nextDashboard.inventoryItems);
      setHasLoadedDashboard(true);
      setHasLoadedInventory(true);
      setIsDashboardStale(false);
      setLastUpdatedAt(savedAt);
      hasUsableDashboardRef.current = true;
      persistDashboard(loadResult.data, savedAt, sessionOwnerKey);
      setLoadError(null);
    } else if (loadResult.state === 'error' || isSuspiciousEmpty) {
      // Stale-while-revalidate: if we already have a chart to show, keep it and
      // flag "couldn't refresh" instead of surfacing a blocking error (or, for a
      // suspicious empty, instead of zeroing the value).
      setIsDashboardStale(true);
      setLoadError(hasUsableDashboardRef.current ? null : loadResult.errorMessage);
    } else {
      setLoadError(null);
    }
    setIsLoadingDashboard(false);
  }, [sessionOwnerKey, setInventoryEntriesCache, setPortfolioDashboardCache, spotlightRepository]);

  // Switch the chart range. If the range hasn't been loaded yet (the dashboard
  // only computed the open range), fetch just that range on demand and merge it
  // in; the chart shows its skeleton via `loadingRange` until it arrives.
  const selectRange = useCallback((range: PortfolioHistoryRange) => {
    setSelectedRange(range);
    if (loadedRangesRef.current.has(range)) {
      return;
    }
    setLoadingRange(range);
    void (async () => {
      try {
        const bucket = await spotlightRepository.getPortfolioRange(range);
        const hasData = bucket.portfolio.length > 0 || bucket.sales.length > 0;
        // Only cache a range once it actually returns data. A cold 3M/1Y read can
        // time out and come back empty; caching that empty bucket made re-tapping
        // the month a no-op ("can't toggle"). Leaving an empty result uncached lets
        // the next tap retry (the cold call also warms the backend cache).
        if (hasData) {
          loadedRangesRef.current.add(range);
          setDashboard((prev) => ({ ...prev, ranges: { ...prev.ranges, [range]: bucket } }));
        }
      } catch {
        // Leave the range empty — the chart shows its empty state, never crashes.
      } finally {
        setLoadingRange((current) => (current === range ? null : current));
      }
    })();
  }, [spotlightRepository]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([loadInventory(), loadDashboard()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadDashboard, loadInventory]);

  // Why: the dashboard refresh fans out 13 parallel requests (inventory +
  // 6 history ranges + 6 ledger ranges). Firing those while the user is on
  // the scanner tab puts a thundering herd on the backend's shared SQLite
  // path right when a scan_match call needs the same connection — that's
  // the contention storm that turned a slab Chansey scan into 118s on
  // staging. Gate the auto-refresh on the portfolio tab being foreground.
  // Pending dataVersion changes are picked up the next time the user
  // switches back to the portfolio tab.
  const { activePage } = useTabsPage();
  const isPortfolioActive = activePage === 'portfolio';

  useEffect(() => {
    if (!isPortfolioActive) return;
    void loadInventory();
    void loadDashboard();
  }, [dataVersion, isPortfolioActive, loadDashboard, loadInventory]);

  // Live-reflect external optimistic adds. When a card is added from the card
  // detail or scanner, `prependOptimisticInventoryEntry` prepends it into the
  // shared inventory cache immediately — but this model owns `dashboard` as
  // local state that doesn't auto-track the cache after mount. Merge any cache
  // entries the on-screen dashboard hasn't seen yet so the new card appears at
  // the top of the grid/list instantly, without waiting on the slow dashboard
  // refetch. Idempotent: `reflectInventoryCacheIntoDashboard` returns the same
  // dashboard reference when the cache introduces no new ids, so this never
  // fights the model's own loads (which set the cache and dashboard together)
  // and the eventual refetch — carrying the same id — replaces the optimistic
  // row seamlessly rather than duplicating it.
  useEffect(() => {
    if (inventoryEntriesCache === null) {
      return;
    }
    setDashboard((current) => reflectInventoryCacheIntoDashboard(current, inventoryEntriesCache));
  }, [inventoryEntriesCache]);

  useEffect(() => {
    if (dashboard.inventoryItems.length === 0 && dashboard.recentSales.length === 0) {
      return;
    }

    void prefetchCardImages(dashboard.inventoryItems.slice(0, 12), 'small');
    void prefetchCardImages(dashboard.recentSales.slice(0, maxRecentSales), 'small');
  }, [dashboard.inventoryItems, dashboard.recentSales]);

  const filteredInventory = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (normalizedQuery.length === 0) {
      return dashboard.inventoryItems;
    }

    return dashboard.inventoryItems.filter((item) => {
      return inventorySearchText(item).includes(normalizedQuery);
    });
  }, [dashboard, searchQuery]);

  const hasInventoryEntries = dashboard.inventoryItems.length > 0;
  const inventoryTotalCount = filteredInventory.length;
  const isLoading = isLoadingInventory || isLoadingDashboard;

  const recentSales = useMemo(() => {
    return dashboard.recentSales.slice(0, maxRecentSales);
  }, [dashboard]);

  const editingSale = useMemo(() => {
    if (!editingSaleId) {
      return null;
    }

    return dashboard.recentSales.find((sale) => sale.id === editingSaleId && sale.kind === 'sold') ?? null;
  }, [dashboard, editingSaleId]);

  const parsedEditingSalePrice = useMemo(() => {
    return parseSellPrice(editingSalePriceText);
  }, [editingSalePriceText]);

  const closeSaleEditor = useCallback(() => {
    setEditingSaleId(null);
    setEditingSalePriceText('');
  }, []);

  const openSaleEditor = useCallback((sale: RecentSaleRecord) => {
    if (sale.kind !== 'sold') {
      return;
    }

    setEditingSaleId(sale.id);
    setEditingSalePriceText(formatEditableSellPrice(sale.soldPrice));
  }, []);

  const updateEditingSalePriceText = useCallback((value: string) => {
    setEditingSalePriceText(sanitizeSellPriceText(value));
  }, []);

  const confirmSalePriceEdit = useCallback(() => {
    if (!editingSaleId || parsedEditingSalePrice == null) {
      return;
    }

    const nextDashboard = applySalePriceEdit(dashboard, editingSaleId, parsedEditingSalePrice);
    setDashboard(nextDashboard);
    setPortfolioDashboardCache(nextDashboard);
    closeSaleEditor();
  }, [closeSaleEditor, dashboard, editingSaleId, parsedEditingSalePrice, setPortfolioDashboardCache]);

  useEffect(() => {
    if (editingSaleId && !editingSale) {
      closeSaleEditor();
    }
  }, [closeSaleEditor, editingSale, editingSaleId]);

  return {
    chartMode,
    dashboard,
    editingSale,
    editingSalePriceText,
    hasLoadedDashboard,
    hasLoadedInventory,
    isLoading,
    isLoadingDashboard,
    isLoadingInventory,
    loadError,
    isDashboardStale,
    lastUpdatedAt,
    canConfirmSalePriceEdit: editingSale !== null && parsedEditingSalePrice != null,
    filteredInventory,
    hasInventoryEntries,
    inventoryExpanded,
    inventoryTotalCount,
    recentSales,
    recentSalesExpanded,
    searchQuery,
    selectedRange,
    // The chart shows its skeleton while the currently-selected range is being
    // fetched on demand.
    isLoadingSelectedRange: loadingRange === selectedRange,
    isRefreshing,
    closeSaleEditor,
    confirmSalePriceEdit,
    openSaleEditor,
    refresh,
    setChartMode,
    setInventoryExpanded,
    setRecentSalesExpanded,
    setSearchQuery,
    // Range switching goes through the on-demand fetcher (kept the exported name
    // so callers don't change).
    setSelectedRange: selectRange,
    updateEditingSalePriceText,
  };
}
