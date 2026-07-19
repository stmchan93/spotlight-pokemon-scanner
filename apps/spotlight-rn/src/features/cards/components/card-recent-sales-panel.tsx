import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { IconLock } from '@tabler/icons-react-native';

import { Button, useSpotlightTheme } from '@spotlight/design-system';
import type { CardRecentSaleRecord, CardRecentSalesRecord } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * Inline "last solds" accordion panel under a graded price-trend row: the last
 * 5 eBay sold listings from the Scrydex recent-sales lane (24h shared cache —
 * one credit per card+grader+grade per day, everything else served from
 * SQLite).
 *
 * Free tier: the most recent sale renders clear; the rest render with REAL
 * data under an unreadable blur + lock, with a subscribe CTA (stubbed until
 * subscriptions land). Premium: all rows clear and tappable (exact Scrydex
 * per-listing deep links).
 */

type CardRecentSalesPanelProps = {
  record: CardRecentSalesRecord | null;
  isLoading: boolean;
  isPremium: boolean;
  /** Aggregated sold-search link ("See all on eBay") — title-derived. */
  seeAllUrl: string | null;
  onSubscribePress: () => void;
  testID?: string;
};

// Sellers often lead titles with the raw cert number ("140550170 Suicune…"),
// which is pure noise on a one-line row — strip a leading 7+ digit run (with
// optional "#"/separator). Never strips card numbers ("088/091" has a slash).
function cleanSaleTitle(title: string): string {
  return title.replace(/^[#\s]*\d{7,}(?![\d/])\s*[-–—:·]?\s*/, '').trim() || title;
}

// "Jun 30" — compact sold-date for the row.
function formatSoldDate(soldAt: string | null | undefined): string | null {
  if (!soldAt) {
    return null;
  }
  const date = new Date(soldAt);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "Updated 3h ago" / "Updated just now" — honest about the 24h cache.
function formatUpdatedAgo(fetchedAt: string | null | undefined): string | null {
  if (!fetchedAt) {
    return null;
  }
  const then = new Date(fetchedAt).valueOf();
  if (Number.isNaN(then)) {
    return null;
  }
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  if (hours <= 0) {
    return 'Updated just now';
  }
  if (hours < 24) {
    return `Updated ${hours}h ago`;
  }
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function SaleRow({
  sale,
  tappable,
  testID,
}: {
  sale: CardRecentSaleRecord;
  tappable: boolean;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const dateText = formatSoldDate(sale.soldAt);
  const displayTitle = cleanSaleTitle(sale.title ?? '');

  const content = (
    <>
      <View style={styles.saleLeft}>
        {dateText ? (
          <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
            {dateText}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={[theme.typography.label, styles.saleTitle, { color: theme.colors.gray700 }]}
        >
          {displayTitle}
        </Text>
      </View>
      <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
        {sale.priceAmount == null ? '—' : formatCurrency(sale.priceAmount, sale.currencyCode)}
      </Text>
    </>
  );

  if (tappable && sale.saleUrl) {
    return (
      <Pressable
        accessibilityLabel={`Open sold listing: ${displayTitle}`}
        accessibilityRole="link"
        onPress={() => {
          void Linking.openURL(sale.saleUrl as string);
        }}
        style={({ pressed }) => [styles.saleRow, { opacity: pressed ? 0.6 : 1 }]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={styles.saleRow} testID={testID}>
      {content}
    </View>
  );
}

export function CardRecentSalesPanel({
  record,
  isLoading,
  isPremium,
  seeAllUrl,
  onSubscribePress,
  testID = 'recent-sales-panel',
}: CardRecentSalesPanelProps) {
  const theme = useSpotlightTheme();

  if (isLoading) {
    return (
      <View style={styles.panel} testID={`${testID}-loading`}>
        <ActivityIndicator color={theme.colors.gray400} size="small" />
      </View>
    );
  }

  const sales = record?.sales ?? [];
  const updatedText = formatUpdatedAgo(record?.fetchedAt);

  if (!record || (record.status !== 'available' && sales.length === 0)) {
    return (
      <View style={styles.panel} testID={`${testID}-error`}>
        <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
          {record ? 'No recent eBay sales found.' : "Couldn't load recent sales."}
        </Text>
      </View>
    );
  }

  if (sales.length === 0) {
    return (
      <View style={styles.panel} testID={`${testID}-empty`}>
        <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
          No recent eBay sales found.
        </Text>
      </View>
    );
  }

  const clearSales = isPremium ? sales : sales.slice(0, 1);
  const lockedSales = isPremium ? [] : sales.slice(1);

  return (
    <View style={styles.panel} testID={testID}>
      {clearSales.map((sale, index) => (
        <SaleRow
          key={sale.id}
          sale={sale}
          tappable
          testID={`${testID}-sale-${index}`}
        />
      ))}

      {lockedSales.length > 0 ? (
        <View testID={`${testID}-locked`}>
          <View style={styles.lockedStack}>
            {lockedSales.map((sale, index) => (
              <SaleRow
                key={sale.id}
                sale={sale}
                tappable={false}
                testID={`${testID}-locked-${index}`}
              />
            ))}
            {/* Unreadable blur over the locked rows (real data underneath —
                the paywall is presentational; the fetch is shared either way). */}
            <BlurView intensity={22} style={StyleSheet.absoluteFill} tint="light" />
            <View style={styles.lockOverlay} pointerEvents="none">
              <IconLock color={theme.colors.gray600} size={16} strokeWidth={2} />
              <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
                {`${lockedSales.length} more recent sales`}
              </Text>
            </View>
          </View>
          <Button
            label="Unlock all recent sales"
            labelStyleVariant="label"
            onPress={onSubscribePress}
            shape="rounded"
            size="sm"
            testID={`${testID}-subscribe`}
            variant="dark"
          />
        </View>
      ) : null}

      <View style={styles.footer}>
        {updatedText ? (
          <Text style={[theme.typography.overline, { color: theme.colors.gray400 }]}>
            {updatedText}
          </Text>
        ) : (
          <View />
        )}
        {seeAllUrl ? (
          <Pressable
            accessibilityLabel="See all sold listings on eBay"
            accessibilityRole="link"
            hitSlop={8}
            onPress={() => {
              void Linking.openURL(seeAllUrl);
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            testID={`${testID}-see-all`}
          >
            <Text style={[theme.typography.labelStrong, { color: theme.colors.gray900 }]}>
              See all on eBay →
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  lockedStack: {
    marginBottom: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  panel: {
    gap: 2,
    paddingBottom: 12,
    paddingTop: 4,
  },
  saleLeft: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    minWidth: 0,
  },
  saleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 34,
  },
  saleTitle: {
    flexShrink: 1,
  },
});
