import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { IconLock } from '@tabler/icons-react-native';

import { Button, useSpotlightTheme } from '@spotlight/design-system';
import type { CardEbayListingRecord, CardEbayListingsRecord } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * Inline "lowest listed" accordion panel — the sibling of CardRecentSalesPanel,
 * sitting directly under it in the expanded graded row. Shows the cheapest
 * CURRENT eBay active listings (Browse API, sorted lowest-price-first), which
 * sidesteps the 90-day sold-comp gap: illiquid grades with no recent sales
 * usually still have a live listing to show and tap through to.
 *
 * Free tier: the single cheapest listing renders clear; the rest render under
 * an unreadable blur + lock with a subscribe CTA. Premium: 5 clear on expand →
 * "Show more" reveals the rest (up to the 20 the screen requests), then
 * "See all on eBay". eBay Browse uses a free app token, so there are no
 * per-view credits either way.
 */

type CardLowestListedPanelProps = {
  record: CardEbayListingsRecord | null;
  isLoading: boolean;
  isPremium: boolean;
  onSubscribePress: () => void;
  /** Fired when "Show more" reveals the rest of the fetched listings (analytics). */
  onShowMorePress?: () => void;
  testID?: string;
};

// Mirror the sold panel's ladder: 5 listings on expand → "Show more" reveals
// the fetched page (up to 20) → "See all on eBay" past that.
const INITIAL_VISIBLE_LISTINGS = 5;
// Free tier: 1 clear listing; a short blurred stack underneath is the upsell.
const LOCKED_PREVIEW_LISTINGS = 4;

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
  tappable,
  testID,
}: {
  listing: CardEbayListingRecord;
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
  isPremium,
  onSubscribePress,
  onShowMorePress,
  testID = 'lowest-listed-panel',
}: CardLowestListedPanelProps) {
  const theme = useSpotlightTheme();
  const [showAllListings, setShowAllListings] = useState(false);

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
    return (
      <View style={styles.panel} testID={`${testID}-error`}>
        <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
          No active eBay listings found.
        </Text>
      </View>
    );
  }

  if (listings.length === 0) {
    return (
      <View style={styles.panel} testID={`${testID}-empty`}>
        <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
          No active eBay listings found.
        </Text>
      </View>
    );
  }

  const visibleListings = showAllListings ? listings : listings.slice(0, INITIAL_VISIBLE_LISTINGS);
  const clearListings = isPremium ? visibleListings : listings.slice(0, 1);
  const lockedListings = isPremium ? [] : listings.slice(1, 1 + LOCKED_PREVIEW_LISTINGS);
  const totalLockedCount = isPremium ? 0 : Math.max(listings.length - 1, 0);
  const hiddenCount = isPremium ? listings.length - visibleListings.length : 0;

  return (
    <View style={styles.panel} testID={testID}>
      {clearListings.map((listing, index) => (
        <ListingRow
          key={listing.id}
          listing={listing}
          tappable
          testID={`${testID}-listing-${index}`}
        />
      ))}

      {lockedListings.length > 0 ? (
        <View testID={`${testID}-locked`}>
          <View style={styles.lockedStack}>
            {lockedListings.map((listing, index) => (
              <ListingRow
                key={listing.id}
                listing={listing}
                tappable={false}
                testID={`${testID}-locked-${index}`}
              />
            ))}
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.lockedScrim]} />
            <BlurView
              experimentalBlurMethod="dimezisBlurView"
              intensity={40}
              style={StyleSheet.absoluteFill}
              tint="light"
            />
            <View style={styles.lockOverlay} pointerEvents="none">
              <IconLock color={theme.colors.gray600} size={16} strokeWidth={2} />
              <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
                {`${totalLockedCount} more listings`}
              </Text>
            </View>
          </View>
          <Button
            label="Unlock all listings"
            labelStyleVariant="label"
            onPress={onSubscribePress}
            shape="rounded"
            size="sm"
            testID={`${testID}-subscribe`}
            variant="dark"
          />
        </View>
      ) : null}

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

      {/* The aggregate "See all on eBay →" search link was removed — like the
          recent-sales one, it was a broad title-search that couldn't reproduce
          the specific listings shown. The per-row listings above link exactly. */}
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
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  lockedScrim: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
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
  showMore: {
    alignItems: 'center',
    paddingVertical: 6,
  },
});

export default CardLowestListedPanel;
