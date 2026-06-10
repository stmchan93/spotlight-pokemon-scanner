import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type {
  CardConditionHistory,
  CardConditionHistoryLane,
  CardConditionHistorySeries,
  CardPriceTrendList as CardPriceTrendListRecord,
} from '@spotlight/api-client';
import { PillButton, useSpotlightTheme } from '@spotlight/design-system';

import { useAppServices } from '@/providers/app-providers';

import { CardPriceTrendList } from './card-price-trend-list';

type CardConditionHistorySectionProps = {
  cardId: string;
  lane: CardConditionHistoryLane;
  testID?: string;
};

// Percent change across a series' market points, oldest → newest; drives the
// sparkline's up/down tint (reused from the price-trend list contract).
function seriesTrendPct(series: CardConditionHistorySeries): number | null {
  const markets = series.points
    .map((point) => point.market)
    .filter((value): value is number => value != null);
  if (markets.length < 2) {
    return null;
  }
  const first = markets[0];
  const last = markets[markets.length - 1];
  if (first === 0) {
    return null;
  }
  return ((last - first) / first) * 100;
}

// Map the selected series into the single-row shape the existing price-trend
// chart already renders, so we reuse one charting path instead of adding a new
// one. Missing market points collapse to 0 to match PriceSparkline's contract.
function buildTrendListForSeries(
  history: CardConditionHistory,
  series: CardConditionHistorySeries,
): CardPriceTrendListRecord {
  const points = series.points.map((point) => point.market ?? 0);
  const lastMarket = [...series.points].reverse().find((point) => point.market != null)?.market ?? null;
  return {
    mode: history.lane,
    provider: history.lane === 'graded' ? 'ebay' : 'tcgplayer',
    rows: [
      {
        label: series.label,
        key: series.key,
        currentPrice: lastMarket,
        currencyCode: history.currencyCode,
        points,
        trendPct: seriesTrendPct(series),
      },
    ],
  };
}

export function CardConditionHistorySection({
  cardId,
  lane,
  testID,
}: CardConditionHistorySectionProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository, dataVersion } = useAppServices();
  const [history, setHistory] = useState<CardConditionHistory | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const title = lane === 'graded' ? 'Price history by grade' : 'Price history by condition';

  // Stale-while-revalidate: keep the prior lane's series painted until the new
  // request resolves, matching the rest of the detail screen's load behavior.
  useEffect(() => {
    let cancelled = false;
    void spotlightRepository
      .getCardConditionHistory({ cardId, lane })
      .then((next) => {
        if (cancelled) {
          return;
        }
        setHistory(next);
        setIsLoaded(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setHistory(null);
        setIsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, dataVersion, lane, spotlightRepository]);

  const series = useMemo(() => history?.series ?? [], [history]);

  // Keep a valid selection as the available series change (lane switch, refetch).
  useEffect(() => {
    if (series.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((current) =>
      current != null && series.some((entry) => entry.key === current)
        ? current
        : series[0].key,
    );
  }, [series]);

  const selectedSeries = useMemo(
    () => series.find((entry) => entry.key === selectedKey) ?? series[0] ?? null,
    [selectedKey, series],
  );

  const trendList = useMemo(
    () => (history && selectedSeries ? buildTrendListForSeries(history, selectedSeries) : null),
    [history, selectedSeries],
  );

  // First load with nothing yet: stay quiet (the rest of the screen is the
  // loading affordance) until the request resolves.
  if (!isLoaded && series.length === 0) {
    return null;
  }

  return (
    <View style={styles.root} testID={testID}>
      <Text style={theme.typography.titleMedium}>{title}</Text>

      {series.length === 0 || !trendList ? (
        <Text
          style={[theme.typography.bodyMedium, { color: theme.colors.gray600 }]}
          testID={testID ? `${testID}-empty` : undefined}
        >
          No condition history yet
        </Text>
      ) : (
        <>
          {series.length > 1 ? (
            <ScrollView
              contentContainerStyle={styles.selectorRow}
              horizontal
              showsHorizontalScrollIndicator={false}
              testID={testID ? `${testID}-selector` : undefined}
            >
              {series.map((entry) => (
                <PillButton
                  key={entry.key}
                  label={entry.label}
                  onPress={() => setSelectedKey(entry.key)}
                  selected={entry.key === selectedSeries?.key}
                  testID={testID ? `${testID}-series-${entry.key}` : undefined}
                  tone="filter"
                />
              ))}
            </ScrollView>
          ) : null}
          <CardPriceTrendList
            list={trendList}
            testID={testID ? `${testID}-chart` : undefined}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 10,
    width: '100%',
  },
  selectorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
});

export default CardConditionHistorySection;
