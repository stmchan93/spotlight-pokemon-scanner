import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  CardPriceTrendMode,
  CardRecentSalesRecord,
  SpotlightRepository,
} from '@spotlight/api-client';

import {
  getCardConditionHistoryCached,
  getCardRecentSalesCacheOnly,
} from '@/features/cards/card-detail-prefetch';
import {
  buildPriceChartModel,
  historySeriesPoints,
  rowIdentity,
  salesPoints,
  selectHistorySeries,
  type ChartPoint,
  type PriceChartModel,
  type PriceChartRange,
  type PriceChartRowIdentity,
} from '@/features/cards/card-price-chart-model';

export type UseCardPriceChartArgs = {
  repository: SpotlightRepository;
  cardId: string;
  /** False until the page knows its printing, so the first fetch picks the right series. */
  enabled: boolean;
  mode: CardPriceTrendMode;
  /** Price Trend row key the chip selected. */
  rowKey: string | null;
  /** The page's selected printing label ("Holofoil"). */
  variantLabel: string | null;
  range: PriceChartRange;
  /** Whether this game has a sold-comps source at all (graded lane). */
  salesEnabled: boolean;
  /** Comps the page already loaded for this row (expanded accordion), reused as-is. */
  seededSales?: CardRecentSalesRecord | null;
};

export type CardPriceChartState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'ready'; model: PriceChartModel };

type Loaded = {
  key: string;
  failed: boolean;
  points: ChartPoint[];
  variant: 'line' | 'sales';
  currencyCode: string;
};

async function loadSeries(
  repository: SpotlightRepository,
  cardId: string,
  identity: PriceChartRowIdentity,
  variantLabel: string | null,
  salesEnabled: boolean,
  seededSales: CardRecentSalesRecord | null | undefined,
): Promise<Omit<Loaded, 'key' | 'failed'>> {
  if (identity.mode === 'raw') {
    const history = await getCardConditionHistoryCached(repository, cardId, 'raw');
    return {
      points: historySeriesPoints(selectHistorySeries(history, identity, variantLabel)),
      variant: 'line',
      currencyCode: history?.currencyCode ?? 'USD',
    };
  }

  const seeded = salesPoints(seededSales);
  const sales = seeded.length > 0 || !salesEnabled
    ? seeded
    : salesPoints(await getCardRecentSalesCacheOnly(repository, cardId, {
      grader: identity.grader,
      grade: identity.grade,
      variantName: identity.variantName,
    }));
  if (sales.length > 0) {
    return { points: sales, variant: 'sales', currencyCode: 'USD' };
  }
  // No stored comps at all: the graded history series (if any) as a plain line.
  const history = await getCardConditionHistoryCached(repository, cardId, 'graded');
  return {
    points: historySeriesPoints(selectHistorySeries(history, identity, identity.variantName)),
    variant: 'line',
    currencyCode: history?.currencyCode ?? 'USD',
  };
}

/**
 * Data for the PDP price chart: one free read per card + lane (raw condition
 * history, or cache-only graded comps), sliced to the range client-side.
 */
export function useCardPriceChart({
  repository,
  cardId,
  enabled,
  mode,
  rowKey,
  variantLabel,
  range,
  salesEnabled,
  seededSales,
}: UseCardPriceChartArgs): CardPriceChartState {
  const identity = useMemo(
    () => (rowKey ? rowIdentity(mode, rowKey, variantLabel) : null),
    [mode, rowKey, variantLabel],
  );
  const requestKey = enabled && identity
    ? [cardId, mode, rowKey, variantLabel ?? '', salesEnabled ? 'sales' : 'nosales'].join('|')
    : null;

  // Read through a ref: a later accordion expand must not refetch the chart.
  const seededSalesRef = useRef(seededSales);
  seededSalesRef.current = seededSales;

  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!requestKey || !identity) {
      return;
    }
    let alive = true;
    loadSeries(repository, cardId, identity, variantLabel, salesEnabled, seededSalesRef.current)
      .then((result) => {
        if (alive) {
          setLoaded({ key: requestKey, failed: false, ...result });
        }
      })
      .catch(() => {
        if (alive) {
          setLoaded({ key: requestKey, failed: true, points: [], variant: 'line', currencyCode: 'USD' });
        }
      });
    return () => {
      alive = false;
    };
    // requestKey encodes every input that changes the fetched series.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const current = loaded && loaded.key === requestKey ? loaded : null;
  const model = useMemo(() => {
    if (!current || current.failed) {
      return null;
    }
    return buildPriceChartModel({
      allPoints: current.points,
      variant: current.variant,
      range,
      nowMs: Date.now(),
      currencyCode: current.currencyCode,
    });
  }, [current, range]);

  if (!requestKey) {
    return enabled ? { status: 'hidden' } : { status: 'loading' };
  }
  if (!current) {
    return { status: 'loading' };
  }
  return model ? { status: 'ready', model } : { status: 'hidden' };
}
