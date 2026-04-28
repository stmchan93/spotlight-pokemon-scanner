import {
  useCallback,
  useEffect,
  useMemo,
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

import {
  formatEditableSellPrice,
  parseSellPrice,
  sanitizeSellPriceText,
} from '@/features/sell/sell-order-helpers';
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
    '7D': { portfolio: [], sales: [] },
    '1M': { portfolio: [], sales: [] },
    '3M': { portfolio: [], sales: [] },
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
      '7D': {
        ...dashboard.ranges['7D'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['7D'].sales, existingSale, priceDelta),
      },
      '1M': {
        ...dashboard.ranges['1M'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['1M'].sales, existingSale, priceDelta),
      },
      '3M': {
        ...dashboard.ranges['3M'],
        sales: updateSalesSeriesForSalePrice(dashboard.ranges['3M'].sales, existingSale, priceDelta),
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
    inventoryEntriesCache,
    setInventoryEntriesCache,
    portfolioDashboardCache,
    setPortfolioDashboardCache,
  } = useAppServices();
  const [dashboard, setDashboard] = useState<PortfolioDashboard>(
    () => portfolioDashboardCache
      ?? (inventoryEntriesCache ? buildInventoryFallbackDashboard(inventoryEntriesCache) : emptyPortfolioDashboard),
  );
  const [hasLoadedInventory, setHasLoadedInventory] = useState(inventoryEntriesCache !== null);
  const [hasLoadedDashboard, setHasLoadedDashboard] = useState(portfolioDashboardCache !== null);
  const [isLoadingInventory, setIsLoadingInventory] = useState(inventoryEntriesCache === null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(portfolioDashboardCache === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<PortfolioHistoryRange>('7D');
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

  const loadDashboard = useCallback(async () => {
    setIsLoadingDashboard(true);
    const loadResult = await spotlightRepository.loadPortfolioDashboard();

    if (loadResult.data && loadResult.state !== 'error') {
      setDashboard(loadResult.data);
      setPortfolioDashboardCache(loadResult.data);
      setInventoryEntriesCache(loadResult.data.inventoryItems);
      setHasLoadedDashboard(true);
      setHasLoadedInventory(true);
    }
    setLoadError(loadResult.state === 'error' ? loadResult.errorMessage : null);
    setIsLoadingDashboard(false);
  }, [setInventoryEntriesCache, setPortfolioDashboardCache, spotlightRepository]);

  useEffect(() => {
    void loadInventory();
    void loadDashboard();
  }, [dataVersion, loadDashboard, loadInventory]);

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
    canConfirmSalePriceEdit: editingSale !== null && parsedEditingSalePrice != null,
    filteredInventory,
    hasInventoryEntries,
    inventoryExpanded,
    inventoryTotalCount,
    recentSales,
    recentSalesExpanded,
    searchQuery,
    selectedRange,
    closeSaleEditor,
    confirmSalePriceEdit,
    openSaleEditor,
    setChartMode,
    setInventoryExpanded,
    setRecentSalesExpanded,
    setSearchQuery,
    setSelectedRange,
    updateEditingSalePriceText,
  };
}
