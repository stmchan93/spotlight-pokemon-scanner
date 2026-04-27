import type {
  AddToCollectionOptions,
  CardDetailQuery,
  CardDetailRecord,
  CatalogSearchResult,
  DeckConditionCode,
  InventoryCardEntry,
  MarketHistoryOption,
  PortfolioChartPoint,
  PortfolioDashboard,
  PortfolioHistoryRange,
  RangeChartData,
  PortfolioSaleRequestPayload,
  PortfolioSaleResponsePayload,
  RecentSaleRecord,
  ScannerMode,
} from './types';

const cdn = 'https://images.pokemontcg.io';
const now = '2026-04-21T18:16:00.000Z';

function cardNumber(value: string) {
  return value.startsWith('#') ? value : `#${value}`;
}

function createHistorySeries(values: readonly number[], labels: readonly string[], dates: readonly string[]) {
  return values.map((value, index) => ({
    isoDate: dates[index] ?? dates[dates.length - 1] ?? now,
    shortLabel: labels[index] ?? labels[labels.length - 1] ?? '',
    value,
  }));
}

function normalizeChartPointDate(isoDate: string) {
  return isoDate.includes('T') ? isoDate : `${isoDate}T12:00:00.000Z`;
}

function inventoryMarketValue(entries: InventoryCardEntry[]) {
  return Number(entries.reduce((sum, entry) => {
    return sum + (entry.marketPrice * entry.quantity);
  }, 0).toFixed(2));
}

function replaceLastPointValue(points: readonly PortfolioChartPoint[], nextValue: number) {
  if (points.length === 0) {
    return [];
  }

  return points.map((point, index) => {
    return {
      ...point,
      value: index === points.length - 1 ? nextValue : point.value,
    };
  });
}

function rebuildSalesSeries(
  templatePoints: readonly PortfolioChartPoint[],
  recentSales: RecentSaleRecord[],
) {
  const nextPoints = templatePoints.map((point) => ({
    ...point,
    value: 0,
  }));

  if (nextPoints.length === 0) {
    return nextPoints;
  }

  const pointTimestamps = nextPoints.map((point) => Date.parse(normalizeChartPointDate(point.isoDate)));
  const rangeStart = pointTimestamps[0] ?? 0;
  const rangeEnd = pointTimestamps[pointTimestamps.length - 1] ?? 0;

  recentSales.forEach((sale) => {
    if (sale.kind !== 'sold') {
      return;
    }

    const saleTimestamp = Date.parse(sale.soldAtISO);
    if (!Number.isFinite(saleTimestamp) || saleTimestamp < rangeStart || saleTimestamp > rangeEnd + 86400000) {
      return;
    }

    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    pointTimestamps.forEach((timestamp, index) => {
      const distance = Math.abs(timestamp - saleTimestamp);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    const point = nextPoints[nearestIndex];
    if (!point) {
      return;
    }

    nextPoints[nearestIndex] = {
      ...point,
      value: Number((point.value + sale.soldPrice).toFixed(2)),
    };
  });

  return nextPoints;
}

function buildDynamicRanges(
  inventoryEntries: InventoryCardEntry[],
  recentSales: RecentSaleRecord[],
): Record<PortfolioHistoryRange, RangeChartData> {
  const currentValue = inventoryMarketValue(inventoryEntries);

  return {
    '7D': {
      portfolio: replaceLastPointValue(dashboardRanges['7D'].portfolio, currentValue),
      sales: rebuildSalesSeries(dashboardRanges['7D'].sales, recentSales),
    },
    '1M': {
      portfolio: replaceLastPointValue(dashboardRanges['1M'].portfolio, currentValue),
      sales: rebuildSalesSeries(dashboardRanges['1M'].sales, recentSales),
    },
    '3M': {
      portfolio: replaceLastPointValue(dashboardRanges['3M'].portfolio, currentValue),
      sales: rebuildSalesSeries(dashboardRanges['3M'].sales, recentSales),
    },
    '1Y': {
      portfolio: replaceLastPointValue(dashboardRanges['1Y'].portfolio, currentValue),
      sales: rebuildSalesSeries(dashboardRanges['1Y'].sales, recentSales),
    },
    ALL: {
      portfolio: replaceLastPointValue(dashboardRanges.ALL.portfolio, currentValue),
      sales: rebuildSalesSeries(dashboardRanges.ALL.sales, recentSales),
    },
  };
}

function buildDynamicSummary(ranges: Record<PortfolioHistoryRange, RangeChartData>) {
  const points = ranges['7D'].portfolio;
  const lastPoint = points[points.length - 1];
  const baselinePoint = points.find((point) => point.value > 0) ?? points[0];
  const changeAmount = baselinePoint && lastPoint
    ? Number((lastPoint.value - baselinePoint.value).toFixed(2))
    : lastPoint?.value ?? 0;
  const changePercent = baselinePoint && lastPoint && baselinePoint.value > 0
    ? Number((((lastPoint.value - baselinePoint.value) / baselinePoint.value) * 100).toFixed(2))
    : 0;

  return {
    asOfLabel: lastPoint?.shortLabel ?? 'Today',
    changeAmount,
    changePercent,
    currentValue: lastPoint?.value ?? 0,
  };
}

export const mockInventoryEntries: InventoryCardEntry[] = [
  {
    id: 'entry-1',
    cardId: 'mcdonalds25-16',
    name: 'Scorbunny',
    cardNumber: '#16/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/16.png`,
    marketPrice: 0.38,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-04-21T03:14:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    costBasisPerUnit: 0.18,
    costBasisTotal: 0.18,
  },
  {
    id: 'entry-2',
    cardId: 'mcdonalds25-21',
    name: 'Oshawott',
    cardNumber: '#21/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/21.png`,
    marketPrice: 0.56,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 2,
    addedAt: '2026-04-20T22:11:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    costBasisPerUnit: 0.25,
    costBasisTotal: 0.5,
  },
  {
    id: 'entry-3',
    cardId: 'xyp-111',
    name: 'Celebi',
    cardNumber: '#XY111',
    setName: 'XY Black Star Promos',
    imageUrl: `${cdn}/xyp/XY111.png`,
    marketPrice: 37.54,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-04-19T21:14:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    costBasisPerUnit: 20.0,
    costBasisTotal: 20.0,
  },
  {
    id: 'entry-4',
    cardId: 'sv-p-47',
    name: 'Charmander',
    cardNumber: '#038',
    setName: 'Scarlet & Violet Promo',
    imageUrl: `${cdn}/svp/47.png`,
    marketPrice: 46.57,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 3,
    addedAt: '2026-04-18T15:40:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    costBasisPerUnit: 11.25,
    costBasisTotal: 33.75,
  },
  {
    id: 'entry-5',
    cardId: 'swshp-SWSH176',
    name: 'Hoopa V',
    cardNumber: '#SWSH176',
    setName: 'Sword & Shield Promo',
    imageUrl: `${cdn}/swshp/SWSH176.png`,
    marketPrice: 0.77,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-04-17T11:35:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    costBasisPerUnit: 0.24,
    costBasisTotal: 0.24,
  },
  {
    id: 'entry-6',
    cardId: 'sv2-232',
    name: 'Mega Dragonite',
    cardNumber: '#232/193',
    setName: 'Paldea Evolved',
    imageUrl: `${cdn}/sv2/232.png`,
    marketPrice: 15.09,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-04-16T09:12:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    costBasisPerUnit: 7.12,
    costBasisTotal: 7.12,
  },
];

export const mockRecentSales: RecentSaleRecord[] = [
  {
    id: 'sale-1',
    cardId: 'mcdonalds25-16',
    kind: 'sold',
    name: 'Scorbunny',
    cardNumber: '#16/25',
    setName: "McDonald's Collection 2021",
    soldPrice: 1,
    currencyCode: 'USD',
    soldAtLabel: 'Sold on Apr 21, 2026',
    soldAtISO: '2026-04-21T12:00:00.000Z',
    imageUrl: `${cdn}/mcdonalds25/16.png`,
  },
  {
    id: 'sale-2',
    cardId: 'mcdonalds25-4',
    kind: 'sold',
    name: 'Turtwig',
    cardNumber: '#4/25',
    setName: "McDonald's Collection 2021",
    soldPrice: 1,
    currencyCode: 'USD',
    soldAtLabel: 'Sold on Apr 21, 2026',
    soldAtISO: '2026-04-21T11:24:00.000Z',
    imageUrl: `${cdn}/mcdonalds25/4.png`,
  },
  {
    id: 'sale-3',
    cardId: 'mcdonalds25-22',
    kind: 'sold',
    name: 'Froakie',
    cardNumber: '#22/25',
    setName: "McDonald's Collection 2021",
    soldPrice: 55,
    currencyCode: 'USD',
    soldAtLabel: 'Sold on Apr 21, 2026',
    soldAtISO: '2026-04-21T10:11:00.000Z',
    imageUrl: `${cdn}/mcdonalds25/22.png`,
  },
  {
    id: 'sale-4',
    cardId: 'mcdonalds25-25',
    kind: 'sold',
    name: 'Pikachu',
    cardNumber: '#25/25',
    setName: "McDonald's Collection 2021",
    soldPrice: 3,
    currencyCode: 'USD',
    soldAtLabel: 'Sold on Apr 21, 2026',
    soldAtISO: '2026-04-21T09:50:00.000Z',
    imageUrl: `${cdn}/mcdonalds25/25.png`,
  },
  {
    id: 'sale-5',
    cardId: 'mcdonalds25-22-repeat',
    kind: 'traded',
    name: 'Froakie',
    cardNumber: '#22/25',
    setName: "McDonald's Collection 2021",
    soldPrice: 1,
    currencyCode: 'USD',
    soldAtLabel: 'Traded on Apr 20, 2026',
    soldAtISO: '2026-04-20T15:03:00.000Z',
    imageUrl: `${cdn}/mcdonalds25/22.png`,
  },
  {
    id: 'sale-6',
    cardId: 'mcdonalds25-21',
    kind: 'sold',
    name: 'Oshawott',
    cardNumber: '#21/25',
    setName: "McDonald's Collection 2021",
    soldPrice: 0.56,
    currencyCode: 'USD',
    soldAtLabel: 'Sold on Apr 20, 2026',
    soldAtISO: '2026-04-20T09:34:00.000Z',
    imageUrl: `${cdn}/mcdonalds25/21.png`,
  },
  {
    id: 'sale-7',
    cardId: 'xyp-111',
    kind: 'sold',
    name: 'Celebi',
    cardNumber: '#XY111',
    setName: 'XY Black Star Promos',
    soldPrice: 37.54,
    currencyCode: 'USD',
    soldAtLabel: 'Sold on Apr 19, 2026',
    soldAtISO: '2026-04-19T10:35:00.000Z',
    imageUrl: `${cdn}/xyp/XY111.png`,
  },
  {
    id: 'sale-8',
    cardId: 'swshp-SWSH176',
    kind: 'traded',
    name: 'Hoopa V',
    cardNumber: '#SWSH176',
    setName: 'Sword & Shield Promo',
    soldPrice: 0.77,
    currencyCode: 'USD',
    soldAtLabel: 'Traded on Apr 18, 2026',
    soldAtISO: '2026-04-18T09:35:00.000Z',
    imageUrl: `${cdn}/swshp/SWSH176.png`,
  },
  {
    id: 'sale-9',
    cardId: 'sv2-232',
    kind: 'traded',
    name: 'Mega Dragonite',
    cardNumber: '#232/193',
    setName: 'Paldea Evolved',
    soldPrice: 15.09,
    currencyCode: 'USD',
    soldAtLabel: 'Traded on Apr 17, 2026',
    soldAtISO: '2026-04-17T08:15:00.000Z',
    imageUrl: `${cdn}/sv2/232.png`,
  },
];

export const mockCatalogResults: CatalogSearchResult[] = [
  {
    id: 'sm7-1',
    cardId: 'sm7-1',
    name: 'Treecko',
    cardNumber: '#001/096',
    setName: '裂空のカリスマ',
    imageUrl: `${cdn}/sm7/1.png`,
    marketPrice: 0.31,
    currencyCode: 'USD',
  },
  {
    id: 'sm7-2',
    cardId: 'sm7-2',
    name: 'Treecko',
    cardNumber: '#002/096',
    setName: '裂空のカリスマ',
    imageUrl: `${cdn}/sm7/2.png`,
    marketPrice: 0.28,
    currencyCode: 'USD',
  },
  {
    id: 'np-3',
    cardId: 'np-3',
    name: 'Treecko',
    cardNumber: '#003',
    setName: 'Nintendo Black Star Promos',
    imageUrl: `${cdn}/np/3.png`,
    marketPrice: 1.42,
    currencyCode: 'USD',
  },
  {
    id: 'dp1-3',
    cardId: 'dp1-3',
    name: 'Treecko',
    cardNumber: '#003/050',
    setName: 'フェアリーライズ',
    imageUrl: `${cdn}/sm7b/3.png`,
    marketPrice: 0.41,
    currencyCode: 'USD',
  },
  {
    id: 'pcg9-3',
    cardId: 'pcg9-3',
    name: 'Treecko',
    cardNumber: '#003/051',
    setName: 'ラセンフォース',
    imageUrl: `${cdn}/pcg9/3.png`,
    marketPrice: 0.45,
    currencyCode: 'USD',
  },
];

const mockScannerCandidates: CatalogSearchResult[] = [
  {
    id: 'mcdonalds25-21-candidate',
    cardId: 'mcdonalds25-21',
    name: 'Oshawott',
    cardNumber: '#21/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/21.png`,
    marketPrice: 0.56,
    currencyCode: 'USD',
  },
  {
    id: 'mcdonalds25-16-candidate',
    cardId: 'mcdonalds25-16',
    name: 'Scorbunny',
    cardNumber: '#16/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/16.png`,
    marketPrice: 0.38,
    currencyCode: 'USD',
  },
  {
    id: 'xyp-111-candidate',
    cardId: 'xyp-111',
    name: 'Celebi',
    cardNumber: '#XY111',
    setName: 'XY Black Star Promos',
    imageUrl: `${cdn}/xyp/XY111.png`,
    marketPrice: 37.54,
    currencyCode: 'USD',
  },
  {
    id: 'sv-p-47-candidate',
    cardId: 'sv-p-47',
    name: 'Charmander',
    cardNumber: '#038',
    setName: 'Scarlet & Violet Promo',
    imageUrl: `${cdn}/svp/47.png`,
    marketPrice: 46.57,
    currencyCode: 'USD',
  },
  {
    id: 'swshp-SWSH176-candidate',
    cardId: 'swshp-SWSH176',
    name: 'Hoopa V',
    cardNumber: '#SWSH176',
    setName: 'Sword & Shield Promo',
    imageUrl: `${cdn}/swshp/SWSH176.png`,
    marketPrice: 0.77,
    currencyCode: 'USD',
  },
  {
    id: 'sv2-232-candidate',
    cardId: 'sv2-232',
    name: 'Mega Dragonite',
    cardNumber: '#232/193',
    setName: 'Paldea Evolved',
    imageUrl: `${cdn}/sv2/232.png`,
    marketPrice: 15.09,
    currencyCode: 'USD',
  },
  {
    id: 'mcdonalds25-22-candidate',
    cardId: 'mcdonalds25-22',
    name: 'Froakie',
    cardNumber: '#22/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/22.png`,
    marketPrice: 55,
    currencyCode: 'USD',
  },
  {
    id: 'mcdonalds25-25-candidate',
    cardId: 'mcdonalds25-25',
    name: 'Pikachu',
    cardNumber: '#25/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/25.png`,
    marketPrice: 3,
    currencyCode: 'USD',
  },
  {
    id: 'sm7-1-candidate',
    cardId: 'sm7-1',
    name: 'Treecko',
    cardNumber: '#001/096',
    setName: '裂空のカリスマ',
    imageUrl: `${cdn}/sm7/1.png`,
    marketPrice: 0.31,
    currencyCode: 'USD',
  },
  {
    id: 'sm7-2-candidate',
    cardId: 'sm7-2',
    name: 'Treecko',
    cardNumber: '#002/096',
    setName: '裂空のカリスマ',
    imageUrl: `${cdn}/sm7/2.png`,
    marketPrice: 0.28,
    currencyCode: 'USD',
  },
];

const defaultVariantOptions: MarketHistoryOption[] = [
  { id: 'normal', label: 'Normal', currentPrice: 0.31 },
  { id: 'raw', label: 'Raw', currentPrice: 0.31 },
];

function historyPoints(price: number) {
  return createHistorySeries(
    [price - 0.05, price - 0.02, price - 0.01, price, price],
    ['Apr 16', 'Apr 18', 'Apr 20', 'Apr 21', 'Apr 21'],
    ['2026-04-16', '2026-04-18', '2026-04-20', '2026-04-21', '2026-04-21'],
  );
}

function defaultInsights(price: number) {
  return [
    { id: 'week', label: 'this week', deltaAmount: 0, deltaPercent: 0 },
    { id: 'twoWeeks', label: 'last 2 weeks', deltaAmount: 0, deltaPercent: 0 },
    { id: 'month', label: 'last month', deltaAmount: 0, deltaPercent: 0 },
  ] as const;
}

export const mockCardDetails: Record<string, CardDetailRecord> = {
  'sm7-1': {
    cardId: 'sm7-1',
    name: 'Treecko',
    cardNumber: '#001/096',
    setName: '裂空のカリスマ',
    imageUrl: `${cdn}/sm7/1.png`,
    largeImageUrl: `${cdn}/sm7/1_hires.png`,
    marketPrice: 0.31,
    currencyCode: 'USD',
    marketplaceLabel: 'TCGPLAYER BUYING OPTIONS',
    marketplaceUrl: 'https://www.tcgplayer.com/search/pokemon/product?q=Treecko+001%2F096',
    marketHistory: {
      currencyCode: 'USD',
      currentPrice: 0.31,
      points: historyPoints(0.31),
      availableVariants: defaultVariantOptions,
      availableConditions: [
        { id: 'near_mint', label: 'Near Mint', currentPrice: 0.31 },
        { id: 'lightly_played', label: 'Lightly Played', currentPrice: 0.22 },
        { id: 'moderately_played', label: 'Moderately Played', currentPrice: 0.14 },
      ],
      selectedVariant: 'normal',
      selectedCondition: 'near_mint',
      insights: [...defaultInsights(0.31)],
    },
    ebayListings: {
      status: 'available',
      statusReason: null,
      unavailableReason: null,
      searchUrl: 'https://www.ebay.com/sch/i.html?_nkw=Treecko+001%2F096&_ipg=5&_sop=15&rt=nc',
      listingCount: 3,
      listings: [
        {
          id: 'ebay:sm7-1-1',
          title: 'Treecko 001/096 Celestial Storm Pokemon card',
          saleType: 'fixed_price',
          listingDate: '2026-04-25',
          priceAmount: 0.99,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000001',
        },
        {
          id: 'ebay:sm7-1-2',
          title: 'Treecko 001/096 LP Pokemon Celestial Storm',
          saleType: 'auction',
          listingDate: '2026-04-24',
          priceAmount: 1.49,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000002',
        },
        {
          id: 'ebay:sm7-1-3',
          title: 'Treecko raw Japanese card #001/096',
          saleType: 'fixed_price',
          listingDate: '2026-04-23',
          priceAmount: 1.95,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000003',
        },
      ],
    },
    ownedEntries: [],
    variantOptions: [...defaultVariantOptions],
  },
  'mcdonalds25-21': {
    cardId: 'mcdonalds25-21',
    name: 'Oshawott',
    cardNumber: '#21/25',
    setName: "McDonald's Collection 2021",
    imageUrl: `${cdn}/mcdonalds25/21.png`,
    largeImageUrl: `${cdn}/mcdonalds25/21_hires.png`,
    marketPrice: 0.56,
    currencyCode: 'USD',
    marketplaceLabel: 'TCGPLAYER BUYING OPTIONS',
    marketplaceUrl: 'https://www.tcgplayer.com/search/pokemon/product?q=Oshawott+21%2F25',
    marketHistory: {
      currencyCode: 'USD',
      currentPrice: 0.56,
      points: createHistorySeries(
        [0.52, 0.52, 0.52, 0.53, 0.56],
        ['Apr 16', 'Apr 17', 'Apr 18', 'Apr 19', 'Apr 20'],
        ['2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20'],
      ),
      availableVariants: [...defaultVariantOptions.map((option) => ({
        ...option,
        currentPrice: 0.56,
      }))],
      availableConditions: [
        { id: 'near_mint', label: 'Near Mint', currentPrice: 0.56 },
        { id: 'lightly_played', label: 'Lightly Played', currentPrice: 0.45 },
        { id: 'moderately_played', label: 'Moderately Played', currentPrice: 0.26 },
      ],
      selectedVariant: 'normal',
      selectedCondition: 'near_mint',
      insights: [
        { id: 'week', label: 'this week', deltaAmount: 0.04, deltaPercent: 7.69 },
        { id: 'twoWeeks', label: 'last 2 weeks', deltaAmount: 0.04, deltaPercent: 7.69 },
        { id: 'month', label: 'last month', deltaAmount: 0.04, deltaPercent: 7.69 },
      ],
    },
    ebayListings: {
      status: 'available',
      statusReason: null,
      unavailableReason: null,
      searchUrl: 'https://www.ebay.com/sch/i.html?_nkw=Oshawott+21%2F25&_ipg=5&_sop=15&rt=nc',
      listingCount: 2,
      listings: [
        {
          id: 'ebay:mcdonalds25-21-1',
          title: 'Oshawott 21/25 McDonalds promo raw',
          saleType: 'fixed_price',
          listingDate: '2026-04-22',
          priceAmount: 1.25,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000011',
        },
        {
          id: 'ebay:mcdonalds25-21-2',
          title: 'Pokemon McDonalds Oshawott 21/25 holo',
          saleType: 'auction',
          listingDate: '2026-04-20',
          priceAmount: 1.5,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000012',
        },
      ],
    },
    ownedEntries: [],
    variantOptions: [...defaultVariantOptions.map((option) => ({
      ...option,
      currentPrice: 0.56,
    }))],
  },
  'xyp-111': {
    cardId: 'xyp-111',
    name: 'Celebi',
    cardNumber: '#XY111',
    setName: 'XY Black Star Promos',
    imageUrl: `${cdn}/xyp/XY111.png`,
    largeImageUrl: `${cdn}/xyp/XY111_hires.png`,
    marketPrice: 37.54,
    currencyCode: 'USD',
    marketplaceLabel: 'TCGPLAYER BUYING OPTIONS',
    marketplaceUrl: 'https://www.tcgplayer.com/search/pokemon/product?q=Celebi+XY111',
    marketHistory: {
      currencyCode: 'USD',
      currentPrice: 37.54,
      points: createHistorySeries(
        [29.11, 31.8, 35.1, 36.5, 37.54],
        ['Apr 16', 'Apr 17', 'Apr 18', 'Apr 19', 'Apr 20'],
        ['2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20'],
      ),
      availableVariants: [...defaultVariantOptions.map((option) => ({
        ...option,
        currentPrice: 37.54,
      }))],
      availableConditions: [
        { id: 'near_mint', label: 'Near Mint', currentPrice: 37.54 },
        { id: 'lightly_played', label: 'Lightly Played', currentPrice: 31.14 },
        { id: 'moderately_played', label: 'Moderately Played', currentPrice: 24.32 },
      ],
      selectedVariant: 'normal',
      selectedCondition: 'near_mint',
      insights: [
        { id: 'week', label: 'this week', deltaAmount: 1.2, deltaPercent: 3.31 },
        { id: 'twoWeeks', label: 'last 2 weeks', deltaAmount: 2.18, deltaPercent: 6.17 },
        { id: 'month', label: 'last month', deltaAmount: 6.02, deltaPercent: 19.1 },
      ],
    },
    ebayListings: {
      status: 'available',
      statusReason: null,
      unavailableReason: null,
      searchUrl: 'https://www.ebay.com/sch/i.html?_nkw=Celebi+XY111&_ipg=5&_sop=15&rt=nc',
      listingCount: 2,
      listings: [
        {
          id: 'ebay:xyp-111-1',
          title: 'Celebi XY111 Black Star Promo raw',
          saleType: 'fixed_price',
          listingDate: '2026-04-25',
          priceAmount: 32.5,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000021',
        },
        {
          id: 'ebay:xyp-111-2',
          title: 'Celebi XY111 near mint promo card',
          saleType: 'auction',
          listingDate: '2026-04-24',
          priceAmount: 34,
          currencyCode: 'USD',
          listingUrl: 'https://www.ebay.com/itm/100000000022',
        },
      ],
    },
    ownedEntries: [],
    variantOptions: [...defaultVariantOptions.map((option) => ({
      ...option,
      currentPrice: 37.54,
    }))],
  },
};

const dashboardRanges = {
  '7D': {
    portfolio: createHistorySeries(
      [0, 82.41, 145.11, 151.72, 151.72, 181.6, 194.61],
      ['Apr 15', 'Apr 16', 'Apr 17', 'Apr 18', 'Apr 19', 'Apr 20', 'Apr 21'],
      ['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20', '2026-04-21'],
    ),
    sales: createHistorySeries(
      [0, 0, 15.09, 0.77, 37.54, 1.56, 60],
      ['Apr 15', 'Apr 16', 'Apr 17', 'Apr 18', 'Apr 19', 'Apr 20', 'Apr 21'],
      ['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20', '2026-04-21'],
    ),
  },
  '1M': {
    portfolio: createHistorySeries(
      [4, 44, 88, 128, 194.61],
      ['Mar 21', 'Mar 28', 'Apr 4', 'Apr 11', 'Apr 21'],
      ['2026-03-21', '2026-03-28', '2026-04-04', '2026-04-11', '2026-04-21'],
    ),
    sales: createHistorySeries(
      [0, 8, 11, 19, 60],
      ['Mar 21', 'Mar 28', 'Apr 4', 'Apr 11', 'Apr 21'],
      ['2026-03-21', '2026-03-28', '2026-04-04', '2026-04-11', '2026-04-21'],
    ),
  },
  '3M': {
    portfolio: createHistorySeries(
      [0, 28, 74, 194.61],
      ['Jan', 'Feb', 'Mar', 'Apr'],
      ['2026-01-21', '2026-02-21', '2026-03-21', '2026-04-21'],
    ),
    sales: createHistorySeries(
      [0, 4, 21, 60],
      ['Jan', 'Feb', 'Mar', 'Apr'],
      ['2026-01-21', '2026-02-21', '2026-03-21', '2026-04-21'],
    ),
  },
  '1Y': {
    portfolio: createHistorySeries(
      [0, 18, 45, 74, 131, 194.61],
      ['May', 'Jul', 'Sep', 'Nov', 'Jan', 'Apr'],
      ['2025-05-21', '2025-07-21', '2025-09-21', '2025-11-21', '2026-01-21', '2026-04-21'],
    ),
    sales: createHistorySeries(
      [0, 2, 9, 12, 24, 60],
      ['May', 'Jul', 'Sep', 'Nov', 'Jan', 'Apr'],
      ['2025-05-21', '2025-07-21', '2025-09-21', '2025-11-21', '2026-01-21', '2026-04-21'],
    ),
  },
  ALL: {
    portfolio: createHistorySeries(
      [0, 8, 15, 44, 88, 194.61],
      ['2023', '2024', 'Jan', 'Mar', 'Apr', 'Now'],
      ['2023-01-01', '2024-01-01', '2026-01-21', '2026-03-21', '2026-04-11', '2026-04-21'],
    ),
    sales: createHistorySeries(
      [0, 0, 8, 17, 31, 60],
      ['2023', '2024', 'Jan', 'Mar', 'Apr', 'Now'],
      ['2023-01-01', '2024-01-01', '2026-01-21', '2026-03-21', '2026-04-11', '2026-04-21'],
    ),
  },
} as const;

export const mockPortfolioDashboard: PortfolioDashboard = buildMockDashboard(
  mockInventoryEntries,
  mockRecentSales,
);

export const mockAddToCollectionOptions: Record<string, AddToCollectionOptions> = {
  'sm7-1': {
    variants: [
      { id: 'normal', label: 'Normal' },
      { id: 'raw', label: 'Raw' },
    ],
    defaultVariant: 'normal',
    defaultPrice: 0.31,
  },
  'mcdonalds25-21': {
    variants: [
      { id: 'normal', label: 'Normal' },
      { id: 'raw', label: 'Raw' },
    ],
    defaultVariant: 'normal',
    defaultPrice: 0.56,
  },
  'xyp-111': {
    variants: [
      { id: 'normal', label: 'Normal' },
      { id: 'raw', label: 'Raw' },
    ],
    defaultVariant: 'normal',
    defaultPrice: 37.54,
  },
};

function cloneEntry(entry: InventoryCardEntry): InventoryCardEntry {
  return { ...entry, slabContext: entry.slabContext ? { ...entry.slabContext } : null };
}

function cloneDetail(detail: CardDetailRecord): CardDetailRecord {
  return {
    ...detail,
    marketHistory: {
      ...detail.marketHistory,
      points: [...detail.marketHistory.points],
      availableVariants: detail.marketHistory.availableVariants.map((variant) => ({ ...variant })),
      availableConditions: detail.marketHistory.availableConditions.map((condition) => ({ ...condition })),
      insights: detail.marketHistory.insights.map((insight) => ({ ...insight })),
    },
    ebayListings: detail.ebayListings
      ? {
        ...detail.ebayListings,
        listings: detail.ebayListings.listings.map((listing) => ({ ...listing })),
      }
      : null,
    ownedEntries: detail.ownedEntries.map(cloneEntry),
    variantOptions: detail.variantOptions.map((option) => ({ ...option })),
  };
}

function formatSoldAtLabel(isoDate: string) {
  return formatTransactionAtLabel('sold', isoDate);
}

function formatTransactionAtLabel(kind: 'sold' | 'traded', isoDate: string) {
  const date = new Date(isoDate);
  const action = kind === 'traded' ? 'Traded on' : 'Sold on';
  return `${action} ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

function saleResponseFromPayload(
  payload: PortfolioSaleRequestPayload,
  deckEntryID: string,
  remainingQuantity: number,
): PortfolioSaleResponsePayload {
  return {
    saleID: `sale-${Math.random().toString(36).slice(2, 10)}`,
    deckEntryID,
    remainingQuantity,
    grossTotal: Number((payload.quantity * payload.unitPrice).toFixed(2)),
    soldAt: payload.soldAt,
    showSessionID: payload.showSessionID,
  };
}

export function seedMockInventoryEntries() {
  return mockInventoryEntries.map(cloneEntry);
}

export function seedMockRecentSales() {
  return mockRecentSales.map((sale) => ({ ...sale }));
}

export function seedMockCatalogResults() {
  return mockCatalogResults.map((result) => ({ ...result }));
}

export function seedMockScannerCandidates(mode: ScannerMode = 'raw') {
  return mockScannerCandidates.map((result, index) => ({
    ...result,
    subtitle: mode === 'slabs'
      ? `PSA ${index % 2 === 0 ? '10' : '9'}`
      : 'Potential match',
  }));
}

export function seedMockCardDetails() {
  return Object.fromEntries(
    Object.entries(mockCardDetails).map(([key, value]) => [key, cloneDetail(value)]),
  ) as Record<string, CardDetailRecord>;
}

export function getMockCardDetail(
  details: Record<string, CardDetailRecord>,
  inventoryEntries: InventoryCardEntry[],
  query: CardDetailQuery,
) {
  const detail = details[query.cardId];

  if (!detail) {
    return null;
  }

  const ownedEntries = inventoryEntries.filter((entry) => entry.cardId === query.cardId);
  return {
    ...cloneDetail(detail),
    ownedEntries: ownedEntries.map(cloneEntry),
  };
}

export function buildMockRecentSale(payload: PortfolioSaleRequestPayload, entry: InventoryCardEntry) {
  return {
    id: `sale-${Math.random().toString(36).slice(2, 10)}`,
    cardId: payload.cardID,
    kind: 'sold',
    name: entry.name,
    cardNumber: entry.cardNumber,
    setName: entry.setName,
    soldPrice: payload.unitPrice,
    currencyCode: payload.currencyCode,
    soldAtLabel: formatSoldAtLabel(payload.soldAt),
    soldAtISO: payload.soldAt,
    imageUrl: entry.imageUrl,
  } satisfies RecentSaleRecord;
}

export function buildMockRecentTrade(
  payload: {
    boughtAt: string;
    cardID: string;
    currencyCode: string;
    quantity: number;
    unitPrice: number;
  },
  entry: InventoryCardEntry,
) {
  return {
    id: `trade-${Math.random().toString(36).slice(2, 10)}`,
    cardId: payload.cardID,
    kind: 'traded',
    name: entry.name,
    cardNumber: entry.cardNumber,
    setName: entry.setName,
    soldPrice: Number((payload.quantity * payload.unitPrice).toFixed(2)),
    currencyCode: payload.currencyCode,
    soldAtLabel: formatTransactionAtLabel('traded', payload.boughtAt),
    soldAtISO: payload.boughtAt,
    imageUrl: entry.imageUrl,
  } satisfies RecentSaleRecord;
}

function sameSlabContext(
  left: InventoryCardEntry['slabContext'],
  right: InventoryCardEntry['slabContext'],
) {
  return (left?.grader ?? null) === (right?.grader ?? null)
    && (left?.grade ?? null) === (right?.grade ?? null)
    && (left?.certNumber ?? null) === (right?.certNumber ?? null)
    && (left?.variantName ?? null) === (right?.variantName ?? null);
}

export function updateInventoryForSale(
  inventoryEntries: InventoryCardEntry[],
  payload: PortfolioSaleRequestPayload,
) {
  const nextEntries = inventoryEntries.map(cloneEntry);
  const requestedEntryId = typeof payload.deckEntryID === 'string' ? payload.deckEntryID.trim() : '';
  const entryIndex = requestedEntryId
    ? nextEntries.findIndex((entry) => entry.id === requestedEntryId)
    : nextEntries.findIndex((entry) => entry.cardId === payload.cardID);

  if (entryIndex === -1) {
    throw new Error(`Missing inventory entry for ${requestedEntryId || payload.cardID}`);
  }

  const entry = nextEntries[entryIndex];
  if (payload.quantity > entry.quantity) {
    throw new Error(`Cannot sell ${payload.quantity} cards from a quantity of ${entry.quantity}`);
  }

  const remainingQuantity = entry.quantity - payload.quantity;
  if (remainingQuantity <= 0) {
    nextEntries.splice(entryIndex, 1);
  } else {
    nextEntries[entryIndex] = {
      ...entry,
      quantity: remainingQuantity,
      costBasisTotal: entry.costBasisPerUnit
        ? Number((entry.costBasisPerUnit * remainingQuantity).toFixed(2))
        : entry.costBasisTotal,
    };
  }

  return {
    updatedEntries: nextEntries,
    saleResponse: saleResponseFromPayload(payload, entry.id, Math.max(remainingQuantity, 0)),
    recentSale: buildMockRecentSale(payload, entry),
  };
}

export function buildMockDashboard(inventoryEntries: InventoryCardEntry[], recentSales: RecentSaleRecord[]) {
  const ranges = buildDynamicRanges(inventoryEntries, recentSales);

  return {
    summary: buildDynamicSummary(ranges),
    inventoryCount: inventoryEntries.length,
    inventoryItems: inventoryEntries.map(cloneEntry),
    recentSales: recentSales.map((sale) => ({ ...sale })),
    ranges,
  } satisfies PortfolioDashboard;
}

export function appendMockBuy(
  inventoryEntries: InventoryCardEntry[],
  details: Record<string, CardDetailRecord>,
  payload: {
    cardID: string;
    slabContext?: InventoryCardEntry['slabContext'];
    variantName?: string | null;
    condition: DeckConditionCode | null;
    quantity: number;
    unitPrice: number;
  },
) {
  const nextEntries = inventoryEntries.map(cloneEntry);
  const detail = details[payload.cardID];
  const normalizedVariantName = payload.variantName?.trim() || null;
  const normalizedSlabContext = payload.slabContext
    ? {
        grader: payload.slabContext.grader?.trim() || '',
        grade: payload.slabContext.grade?.trim() || null,
        certNumber: payload.slabContext.certNumber?.trim() || null,
        variantName: payload.slabContext.variantName?.trim() || null,
      }
    : null;
  const entryKind = normalizedSlabContext?.grader ? 'graded' : 'raw';
  const existingIndex = nextEntries.findIndex(
    (entry) => {
      if (entry.cardId !== payload.cardID || entry.kind !== entryKind) {
        return false;
      }

      if (entryKind === 'graded') {
        return sameSlabContext(entry.slabContext ?? null, normalizedSlabContext);
      }

      return (entry.variantName ?? null) === normalizedVariantName
        && (entry.conditionCode ?? 'near_mint') === (payload.condition ?? 'near_mint');
    },
  );

  if (existingIndex >= 0) {
    const existing = nextEntries[existingIndex];
    nextEntries[existingIndex] = {
      ...existing,
      quantity: existing.quantity + payload.quantity,
      costBasisTotal: Number(((existing.costBasisTotal ?? 0) + payload.unitPrice * payload.quantity).toFixed(2)),
    };

    return {
      updatedEntries: nextEntries,
      deckEntryID: existing.id,
      inserted: false,
    };
  }

  if (!detail) {
    throw new Error(`Missing detail for ${payload.cardID}`);
  }

  const newEntry: InventoryCardEntry = {
    id: `entry-${Math.random().toString(36).slice(2, 10)}`,
    cardId: detail.cardId,
    name: detail.name,
    cardNumber: detail.cardNumber,
    setName: detail.setName,
    imageUrl: detail.imageUrl,
    marketPrice: detail.marketPrice,
    hasMarketPrice: true,
    currencyCode: detail.currencyCode,
    quantity: payload.quantity,
    addedAt: new Date().toISOString(),
    kind: entryKind,
    variantName: entryKind === 'raw' ? normalizedVariantName : (normalizedSlabContext?.variantName ?? null),
    conditionCode: payload.condition ?? 'near_mint',
    conditionLabel: payload.condition ? deckConditionLabel(payload.condition) : 'Near Mint',
    conditionShortLabel: payload.condition ? deckConditionShortLabel(payload.condition) : 'NM',
    slabContext: entryKind === 'graded'
      ? {
          grader: normalizedSlabContext?.grader ?? 'PSA',
          grade: normalizedSlabContext?.grade ?? null,
          certNumber: normalizedSlabContext?.certNumber ?? null,
          variantName: normalizedSlabContext?.variantName ?? null,
        }
      : null,
    costBasisPerUnit: payload.unitPrice,
    costBasisTotal: Number((payload.unitPrice * payload.quantity).toFixed(2)),
  };

  nextEntries.unshift(newEntry);
  return {
    updatedEntries: nextEntries,
    deckEntryID: newEntry.id,
    inserted: true,
  };
}

function deckConditionLabel(code: DeckConditionCode) {
  switch (code) {
    case 'near_mint':
      return 'Near Mint';
    case 'lightly_played':
      return 'Lightly Played';
    case 'moderately_played':
      return 'Moderately Played';
    case 'heavily_played':
      return 'Heavily Played';
    case 'damaged':
      return 'Damaged';
  }
}

function deckConditionShortLabel(code: DeckConditionCode) {
  switch (code) {
    case 'near_mint':
      return 'NM';
    case 'lightly_played':
      return 'LP';
    case 'moderately_played':
      return 'MP';
    case 'heavily_played':
      return 'HP';
    case 'damaged':
      return 'DMG';
  }
}
