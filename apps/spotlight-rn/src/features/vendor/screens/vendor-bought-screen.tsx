import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { VendorBoughtEntry, VendorBoughtLog } from '@spotlight/api-client';
import { StateCard, SurfaceCard, Text, colors, radii, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { ChromeBackButton } from '@/components/chrome-back-button';
import { useAppServices } from '@/providers/app-providers';

import { formatSignedUsd, formatUsd } from '../vendor-pricing';

const CONDITION_SHORT: Record<string, string> = {
  near_mint: 'NM',
  lightly_played: 'LP',
  moderately_played: 'MP',
  heavily_played: 'HP',
  damaged: 'DMG',
};

export function boughtEntryDetail(entry: VendorBoughtEntry): string {
  const grade = entry.grader
    ? `${entry.grader} ${entry.grade ?? ''}`.trim()
    : CONDITION_SHORT[entry.condition ?? ''] ?? 'NM';
  return [entry.setName, entry.number ? `#${entry.number}` : null, entry.grader ? null : entry.variantName, grade]
    .filter(Boolean)
    .join(' · ');
}

export function formatBoughtDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

type LoadState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; log: VendorBoughtLog };

export function VendorBoughtScreen({ onBack }: { onBack?: () => void }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { dataVersion, spotlightRepository } = useAppServices();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    const log = await spotlightRepository.fetchVendorBoughtLog().catch(() => null);
    setState(log ? { status: 'ready', log } : { status: 'failed' });
  }, [spotlightRepository]);

  useEffect(() => {
    void load();
  }, [dataVersion, load]);

  const secondary = [theme.typography.caption, { color: theme.colors.textSecondary }];
  const profitColor = (value: number) => (value >= 0 ? theme.colors.success : theme.colors.danger);

  const header = (
    <View style={{ gap: theme.spacing.md, paddingBottom: theme.spacing.md }}>
      <View style={[styles.header, { gap: theme.spacing.md }]}>
        {onBack ? <ChromeBackButton onPress={onBack} testID="vendor-bought-back" /> : null}
        <View style={{ gap: theme.spacing.xxs }}>
          <Text style={theme.typography.display}>Bought</Text>
          <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
            Cards you bought from the scanner at your offer, and what they&apos;re worth now.
          </Text>
        </View>
      </View>
      {state.status === 'ready' && state.log.entries.length > 0 ? (
        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={[styles.summaryRow, { gap: theme.spacing.sm }]} testID="vendor-bought-summary">
            <SummaryCell label="PAID" value={formatUsd(state.log.summary.paidUsd)} />
            <SummaryCell label="MARKET THEN" value={formatUsd(state.log.summary.marketAtBuyUsd)} />
            <SummaryCell label="NOW" value={formatUsd(state.log.summary.currentValueUsd)} />
          </View>
          {(() => {
            // Profit only over cards that still have a price today.
            const priced = state.log.entries.filter((entry) => entry.profitUsd != null);
            if (priced.length === 0) {
              return null;
            }
            const profit = priced.reduce((total, entry) => total + (entry.profitUsd ?? 0), 0);
            return (
              <Text
                style={[theme.typography.bodyMedium, { color: profitColor(profit), marginTop: theme.spacing.sm }]}
                testID="vendor-bought-total-profit"
              >
                {`${formatSignedUsd(Math.round(profit * 100) / 100)} profit${priced.length < state.log.entries.length ? ' on priced cards' : ''}`}
              </Text>
            );
          })()}
        </SurfaceCard>
      ) : null}
    </View>
  );

  const renderItem = ({ item }: { item: VendorBoughtEntry }) => (
    <View
      style={[styles.row, { borderBottomColor: theme.colors.gray200, gap: theme.spacing.sm, paddingVertical: theme.spacing.sm }]}
      testID={`vendor-bought-row-${item.batchId}-${item.lineIndex}`}
    >
      <View style={styles.thumbWrap}>
        {item.imageUrl ? <CachedImage contentFit="contain" style={styles.thumb} uri={item.imageUrl} /> : null}
      </View>
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]}>
          {item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name}
        </Text>
        <Text numberOfLines={1} style={secondary}>{boughtEntryDetail(item)}</Text>
        <Text style={secondary}>{formatBoughtDate(item.boughtAt)}</Text>
      </View>
      <View style={styles.rowPrices}>
        <Text style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]} testID="vendor-bought-paid">
          {`Paid ${formatUsd(item.paidUsd)}`}
        </Text>
        <Text style={secondary}>
          {`Mkt ${item.marketAtBuyUsd == null ? '—' : formatUsd(item.marketAtBuyUsd)} · Now ${item.currentValueUsd == null ? '—' : formatUsd(item.currentValueUsd)}`}
        </Text>
        {item.profitUsd == null ? null : (
          <Text style={[theme.typography.captionStrong, { color: profitColor(item.profitUsd) }]} testID="vendor-bought-profit">
            {formatSignedUsd(item.profitUsd)}
          </Text>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
      <FlatList
        ListEmptyComponent={state.status === 'loading' ? (
          <ActivityIndicator testID="vendor-bought-loading" />
        ) : state.status === 'failed' ? (
          <StateCard
            actionLabel="Try again"
            message="Couldn't load your Bought log."
            onActionPress={() => {
              setState({ status: 'loading' });
              void load();
            }}
            testID="vendor-bought-error"
            title="Something went wrong"
          />
        ) : (
          <StateCard
            message="In the scanner, pick MY BUY PRICE from the TOTAL menu, then tap BOUGHT when a seller takes your offer."
            testID="vendor-bought-empty"
            title="Nothing bought yet"
          />
        )}
        ListHeaderComponent={header}
        contentContainerStyle={{
          paddingBottom: theme.spacing.xxxl + insets.bottom,
          paddingHorizontal: theme.layout.pageGutter,
          paddingTop: theme.layout.pageTopInset,
        }}
        data={state.status === 'ready' ? state.log.entries : []}
        keyExtractor={(item) => `${item.batchId}:${item.lineIndex}`}
        renderItem={renderItem}
        testID="vendor-bought"
      />
    </SafeAreaView>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.summaryCell}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>{label}</Text>
      <Text style={[theme.typography.titleSmall, { color: theme.colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'flex-start',
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  rowPrices: {
    alignItems: 'flex-end',
  },
  safeArea: {
    flex: 1,
  },
  summaryCell: {
    flex: 1,
  },
  summaryRow: {
    flexDirection: 'row',
  },
  thumb: {
    height: 56,
    width: 40,
  },
  thumbWrap: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    height: 56,
    overflow: 'hidden',
    width: 40,
  },
});
