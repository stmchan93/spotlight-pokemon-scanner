import { Fragment, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react-native';

import { borderWidths, colors, PriceSparkline, Text, useSpotlightTheme } from '@spotlight/design-system';
import type {
  CardPriceTrendList as CardPriceTrendListType,
  CardPriceTrendRow,
} from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';


type CardPriceTrendListProps = {
  list: CardPriceTrendListType;
  /**
   * When provided, each row becomes a button that deep-links to the marketplace
   * for that grade/condition. Absent → rows render static (unchanged).
   */
  onRowPress?: (row: CardPriceTrendRow) => void;
  /**
   * When provided, the provider logo (eBay / TCGplayer) becomes a button that
   * deep-links to the marketplace for the grade/condition currently selected on
   * the PDP — TCGplayer Near Mint for raw, eBay sold listings for the selected
   * grade/grader. Absent → the logo renders as a static image (unchanged).
   */
  onProviderPress?: () => void;
  /** Row key currently resolving its marketplace link (shows a spinner). */
  loadingRowKey?: string | null;
  /**
   * Accordion: the row whose chevron is expanded (points down) and whose
   * `expandedContent` renders beneath it, above the divider. The list stays
   * dumb — the parent owns the state and the content.
   */
  expandedRowKey?: string | null;
  expandedContent?: ReactNode;
  testID?: string;
};

const SPARKLINE_WIDTH = 62;
const SPARKLINE_HEIGHT = 22;

export function CardPriceTrendList({
  list,
  onRowPress,
  onProviderPress,
  loadingRowKey,
  expandedRowKey,
  expandedContent,
  testID,
}: CardPriceTrendListProps) {
  const theme = useSpotlightTheme();
  const logoSource =
    list.provider === 'ebay'
      ? require('../../../../assets/images/ebay-logo.png')
      : require('../../../../assets/images/tcgplayer-logo.png');
  const providerLabel = list.provider === 'ebay' ? 'eBay' : 'TCGplayer';
  // Official brand logos at the Figma PDP sizes: eBay 50×20 (992-7804),
  // TCGplayer 27×20 (992-7802).
  const logoStyle = list.provider === 'ebay' ? styles.logoEbay : styles.logoTcg;

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.header}>
        <Text style={theme.typography.titleMedium}>Price Trend</Text>
        {onProviderPress ? (
          <Pressable
            accessibilityLabel={`Open on ${providerLabel}`}
            accessibilityRole="button"
            hitSlop={12}
            onPress={onProviderPress}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            testID={testID ? `${testID}-provider` : undefined}
          >
            <Image resizeMode="contain" source={logoSource} style={logoStyle} />
          </Pressable>
        ) : (
          <Image
            accessibilityLabel={providerLabel}
            resizeMode="contain"
            source={logoSource}
            style={logoStyle}
          />
        )}
      </View>

      {/* Full-bleed hairline under the title, then one under every row (Figma
          992-7381): each rule spans edge-to-edge and never doubles up where two
          rows meet. */}
      <View style={[styles.divider, { backgroundColor: theme.colors.gray300 }]} />

      {list.rows.map((row) => {
        const isLoading = row.key === loadingRowKey;
        const isExpanded = expandedRowKey != null && row.key === expandedRowKey;
        const rowTestID = testID ? `${testID}-row-${row.key}` : undefined;
        const rowContent = (
          <>
            <View style={styles.label}>
              <Text style={[theme.typography.body, styles.gradeLabel]} numberOfLines={1}>
                {row.label}
              </Text>
            </View>
            {/* Sparkline + price as one right-aligned group (Figma 1664:1090
                "Price Chart": 62×22 sparkline, gap 32, Body-medium price). */}
            <View style={styles.priceGroup}>
              <PriceSparkline
                height={SPARKLINE_HEIGHT}
                points={row.points}
                testID={testID ? `${testID}-spark-${row.key}` : undefined}
                trendPct={row.trendPct}
                width={SPARKLINE_WIDTH}
              />
              {isLoading ? (
                <View
                  style={[styles.price, styles.pricePending]}
                  testID={testID ? `${testID}-price-${row.key}` : undefined}
                >
                  <ActivityIndicator color={theme.colors.gray400} size="small" />
                </View>
              ) : (
                <Text
                  style={[theme.typography.bodyMedium, styles.price]}
                  testID={testID ? `${testID}-price-${row.key}` : undefined}
                >
                  {row.currentPrice == null
                    ? '—'
                    : formatCurrency(row.currentPrice, row.currencyCode)}
                </Text>
              )}
            </View>
            {onRowPress ? (
              // Larger (20px) + darker (gray-600 / #717171) chevron per Figma
              // 2566:5298 so the tappable marketplace rows clearly read as
              // clickable. Expanded accordion rows point DOWN.
              isExpanded ? (
                <IconChevronDown
                  color={theme.colors.gray600}
                  size={20}
                  strokeWidth={2}
                  testID={rowTestID ? `${rowTestID}-chevron-open` : undefined}
                />
              ) : (
                <IconChevronRight color={theme.colors.gray600} size={20} strokeWidth={2} />
              )
            ) : null}
          </>
        );

        return (
          <Fragment key={row.key}>
            {onRowPress ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                disabled={isLoading}
                onPress={() => onRowPress(row)}
                style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
                testID={rowTestID}
              >
                {rowContent}
              </Pressable>
            ) : (
              <View style={styles.row} testID={rowTestID}>
                {rowContent}
              </View>
            )}
            {isExpanded && expandedContent != null ? (
              <View testID={rowTestID ? `${rowTestID}-expanded` : undefined}>
                {expandedContent}
              </View>
            ) : null}
            <View style={[styles.divider, { backgroundColor: theme.colors.gray300 }]} />
          </Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    // Break out of the screen's 16px content padding so the rule spans the full
    // device width (Figma 992-7381 row frame is 393px / edge-to-edge). 0.5pt
    // gray-300 rule per Figma 2489:7581 (borderWidths.rule, NOT hairlineWidth).
    height: borderWidths.rule,
    marginHorizontal: -16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  // Figma 1664:1090 grade label: Body (Plus Jakarta Regular) at 14/gray-700,
  // muted so the price stays the emphasis.
  gradeLabel: {
    color: colors.gray700,
    fontSize: 14,
    lineHeight: 21,
  },
  label: {
    flex: 1,
  },
  logoEbay: {
    height: 20,
    width: 50,
  },
  logoTcg: {
    height: 20,
    width: 27,
  },
  price: {
    minWidth: 72,
    textAlign: 'right',
  },
  // Figma 1664:1090 "Price Chart": the sparkline and price sit together,
  // right-aligned, with a 32px gap between them.
  priceGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 32,
  },
  pricePending: {
    alignItems: 'flex-end',
  },
  root: {
    width: '100%',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
});

export default CardPriceTrendList;
