import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';
import type { CardEbayListingRecord, CardEbayListingsRecord } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * Inline "lowest listed" accordion panel — the sibling of CardRecentSalesPanel,
 * sitting directly under it in the expanded graded row. Shows the cheapest
 * CURRENT eBay active listings (Browse API, sorted lowest-price-first), which
 * sidesteps the 90-day sold-comp gap: illiquid grades with no recent sales
 * usually still have a live listing to show and tap through to.
 *
 * Everyone sees 5 clear rows on expand → "Show more" reveals the rest (up to
 * the 20 the screen requests), then "See all on eBay". eBay Browse uses a free
 * app token, so there are no per-view credits. The old free-tier blur/subscribe
 * paywall was removed 2026-08-12 along with RevenueCat — monetization is
 * deferred.
 */

type CardLowestListedPanelProps = {
  record: CardEbayListingsRecord | null;
  isLoading: boolean;
  /** Fired when "Show more" reveals the rest of the fetched listings (analytics). */
  onShowMorePress?: () => void;
  /**
   * Opens an eBay SEARCH for this card's live listings, cheapest first. Rendered
   * both when the panel is empty and under a populated list, so `hasRows` says
   * which — leaving from a full panel means something different from leaving
   * because there was nothing here.
   */
  onSeeMoreOnEbayPress?: (context: { hasRows: boolean }) => void;
  /** A single listing row was opened on eBay (analytics; the row opens itself). */
  onListingPress?: () => void;
  testID?: string;
};

// Mirror the sold panel's ladder: 5 listings on expand → "Show more" reveals
// the fetched page (up to 20) → "See all on eBay" past that.
const INITIAL_VISIBLE_LISTINGS = 5;

// Sellers often lead titles with the raw cert number ("140550170 Suicune…").
// Strip a leading 7+ digit run (matches the sold-panel cleaner).
function cleanListingTitle(title: string): string {
  return title.replace(/^[#\s]*\d{7,}(?![\d/])\s*[-–—:·]?\s*/, '').trim() || title;
}

// "Buy It Now" / "Auction" tag for the row's left slot (mirrors the sold-date
// slot). Unknown/empty types render nothing.
function formatSaleType(saleType: string | null | undefined): string | null {
  const normalized = (saleType ?? '').trim().toLowerCase();
  if (normalized === 'fixed_price') {
    return 'Buy It Now';
  }
  if (normalized === 'auction') {
    return 'Auction';
  }
  return null;
}

function ListingRow({
  listing,
  onPress,
  tappable,
  testID,
}: {
  listing: CardEbayListingRecord;
  onPress?: () => void;
  tappable: boolean;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const typeText = formatSaleType(listing.saleType);
  const displayTitle = cleanListingTitle(listing.title ?? '');

  const content = (
    <>
      <View style={styles.listingLeft}>
        {typeText ? (
          <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
            {typeText}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={[theme.typography.label, styles.listingTitle, { color: theme.colors.gray700 }]}
        >
          {displayTitle}
        </Text>
      </View>
      <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
        {listing.priceAmount == null ? '—' : formatCurrency(listing.priceAmount, listing.currencyCode)}
      </Text>
    </>
  );

  if (tappable && listing.listingUrl) {
    return (
      <Pressable
        accessibilityLabel={`Open eBay listing: ${displayTitle}`}
        accessibilityRole="link"
        onPress={() => {
          onPress?.();
          void Linking.openURL(listing.listingUrl as string);
        }}
        style={({ pressed }) => [styles.listingRow, { opacity: pressed ? 0.6 : 1 }]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={styles.listingRow} testID={testID}>
      {content}
    </View>
  );
}

export function CardLowestListedPanel({
  record,
  isLoading,
  onShowMorePress,
  onSeeMoreOnEbayPress,
  onListingPress,
  testID = 'lowest-listed-panel',
}: CardLowestListedPanelProps) {
  const theme = useSpotlightTheme();
  const [showAllListings, setShowAllListings] = useState(false);

  // Unavailable and genuinely-empty render identically — same line, same way
  // out. See the twin helper in `card-recent-sales-panel.tsx`.
  const renderNothingFound = (branchTestID: string) => (
    <View style={styles.panel} testID={branchTestID}>
      <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
        No active eBay listings found.
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

  const listings = record?.listings ?? [];

  // Degrade gracefully: whether eBay Browse is unavailable (daily rate limit /
  // auth) or genuinely returned nothing, show the same calm "none found" line —
  // never an alarming "Couldn't load" error. No extra calls either way.
  if (!record || (record.status !== 'available' && listings.length === 0)) {
    return renderNothingFound(`${testID}-error`);
  }

  if (listings.length === 0) {
    return renderNothingFound(`${testID}-empty`);
  }

  const visibleListings = showAllListings ? listings : listings.slice(0, INITIAL_VISIBLE_LISTINGS);
  const hiddenCount = listings.length - visibleListings.length;

  return (
    <View style={styles.panel} testID={testID}>
      {visibleListings.map((listing, index) => (
        <ListingRow
          key={listing.id}
          listing={listing}
          onPress={onListingPress}
          tappable
          testID={`${testID}-listing-${index}`}
        />
      ))}

      {hiddenCount > 0 ? (
        <Pressable
          accessibilityLabel={`Show ${hiddenCount} more listings`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            setShowAllListings(true);
            onShowMorePress?.();
          }}
          style={({ pressed }) => [styles.showMore, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-show-more`}
        >
          <Text style={[theme.typography.labelStrong, { color: theme.colors.gray600 }]}>
            {`Show ${hiddenCount} more listings`}
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
  listingLeft: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    minWidth: 0,
  },
  listingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 34,
  },
  listingTitle: {
    flexShrink: 1,
  },
  panel: {
    gap: 2,
    paddingBottom: 12,
    paddingTop: 4,
  },
  showMore: {
    alignItems: 'center',
    paddingVertical: 6,
  },
});

export default CardLowestListedPanel;
