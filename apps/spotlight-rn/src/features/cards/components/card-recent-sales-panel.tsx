import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';
import type { CardRecentSaleRecord, CardRecentSalesRecord } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * Inline "last solds" accordion panel under a graded price-trend row: the last
 * 5 eBay sold listings from the Scrydex recent-sales lane (24h shared cache —
 * one credit per card+grader+grade per day, everything else served from
 * SQLite).
 *
 * All rows are clear and tappable for everyone (exact Scrydex per-listing deep
 * links). The old free-tier blur/subscribe paywall was removed 2026-08-12 along
 * with RevenueCat — monetization is deferred.
 */

type CardRecentSalesPanelProps = {
  record: CardRecentSalesRecord | null;
  isLoading: boolean;
  /** Fired when "Show more" reveals the rest of the fetched sales (analytics). */
  onShowMorePress?: () => void;
  /**
   * Opens an eBay SEARCH for this card. Rendered ONLY when there is nothing to
   * show — an empty panel is otherwise a dead end, and with no rows on screen
   * there are no accurate comps for an approximate search to contradict. It is
   * deliberately absent from the populated panel: a title-derived search cannot
   * reproduce these specific sold listings, which is why the old always-on
   * "See all on eBay" footer was removed. Omit to render no footer at all.
   */
  onSeeMoreOnEbayPress?: (context: { hasRows: boolean }) => void;
  /** A single sold row was opened on eBay (analytics; the row opens itself). */
  onSalePress?: () => void;
  testID?: string;
};

// Ladder: 5 sales on expand → "Show more" reveals the rest of the fetched
// page (up to the 20 the screen requests) → "See all on eBay" deep link past
// that. All served from the same cached Scrydex page, zero extra credits.
const INITIAL_VISIBLE_SALES = 5;

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
  onPress,
  sale,
  tappable,
  testID,
}: {
  onPress?: () => void;
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
          onPress?.();
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
  onShowMorePress,
  onSeeMoreOnEbayPress,
  onSalePress,
  testID = 'recent-sales-panel',
}: CardRecentSalesPanelProps) {
  const theme = useSpotlightTheme();
  const [showAllSales, setShowAllSales] = useState(false);

  // "Nothing found" is reached two ways — the source was unavailable, or it
  // genuinely returned zero — and both render the same calm line plus the same
  // way out, so they share one renderer.
  const renderNothingFound = (branchTestID: string) => (
    <View style={styles.panel} testID={branchTestID}>
      <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
        No recent eBay sales found.
      </Text>
      {onSeeMoreOnEbayPress ? (
        <Pressable
          accessibilityHint="Opens eBay outside the app"
          accessibilityLabel="See more on eBay"
          accessibilityRole="link"
          hitSlop={8}
          onPress={() => onSeeMoreOnEbayPress({ hasRows: false })}
          style={({ pressed }) => [styles.showMore, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-see-more`}
        >
          <Text style={[theme.typography.labelStrong, { color: theme.colors.gray600 }]}>
            See more on eBay ↗
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (isLoading) {
    return (
      <View style={styles.panel} testID={`${testID}-loading`}>
        <ActivityIndicator color={theme.colors.gray400} size="small" />
      </View>
    );
  }

  const sales = record?.sales ?? [];
  const updatedText = formatUpdatedAgo(record?.fetchedAt);

  // Degrade gracefully: whether the live Scrydex sold-comps call is unavailable
  // (e.g. staging runs keyless to save credits) or genuinely returned nothing,
  // show the same calm "none found" line — never an alarming "Couldn't load".
  if (!record || (record.status !== 'available' && sales.length === 0)) {
    return renderNothingFound(`${testID}-error`);
  }

  if (sales.length === 0) {
    return renderNothingFound(`${testID}-empty`);
  }

  // 5 clear rows on expand, then Show more expands to the full fetched page.
  const visibleSales = showAllSales ? sales : sales.slice(0, INITIAL_VISIBLE_SALES);
  const hiddenCount = sales.length - visibleSales.length;

  return (
    <View style={styles.panel} testID={testID}>
      {visibleSales.map((sale, index) => (
        <SaleRow
          key={sale.id}
          onPress={onSalePress}
          sale={sale}
          tappable
          testID={`${testID}-sale-${index}`}
        />
      ))}

      {hiddenCount > 0 ? (
        <Pressable
          accessibilityLabel={`Show ${hiddenCount} more recent sales`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            setShowAllSales(true);
            onShowMorePress?.();
          }}
          style={({ pressed }) => [styles.showMore, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-show-more`}
        >
          <Text style={[theme.typography.labelStrong, { color: theme.colors.gray600 }]}>
            {`Show ${hiddenCount} more sales`}
          </Text>
        </Pressable>
      ) : null}

      {/*
        RESTORED at the user's request, and always present: a jump to the same
        search on eBay proper. It was removed once because the title-derived
        search couldn't reproduce the exact inline comps — but the query is now
        a single readable phrase ('"PSA 10" <name> <set>'), so what eBay shows
        is legible and editable rather than a paren-soup mystery, and having NO
        way out to eBay when rows exist read as a missing feature.
      */}
      {onSeeMoreOnEbayPress ? (
        <Pressable
          accessibilityHint="Opens eBay outside the app"
          accessibilityLabel="See more on eBay"
          accessibilityRole="link"
          hitSlop={8}
          onPress={() => onSeeMoreOnEbayPress({ hasRows: true })}
          style={({ pressed }) => [styles.showMore, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-see-more`}
        >
          <Text style={[theme.typography.labelStrong, { color: theme.colors.gray600 }]}>
            See more on eBay ↗
          </Text>
        </Pressable>
      ) : null}
      {updatedText ? (
        <View style={styles.footer}>
          <Text style={[theme.typography.overline, { color: theme.colors.gray400 }]}>
            {updatedText}
          </Text>
        </View>
      ) : null}
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
  showMore: {
    alignItems: 'center',
    paddingVertical: 6,
  },
});
