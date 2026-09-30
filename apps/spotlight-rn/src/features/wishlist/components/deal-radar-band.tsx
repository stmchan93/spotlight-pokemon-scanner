import { useEffect, useRef } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { ShareIos, Xmark } from 'iconoir-react-native';

import { buildWatchKey, type CardFavoriteEntry, type DealAlert } from '@spotlight/api-client';
import {
  DeltaPill,
  IconButton,
  SectionHeader,
  SurfaceCard,
  Text,
  iconButtonDefaultGlyphSize,
  layout,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import {
  buildDealHeadline,
  buildDiscountLabel,
  buildTierLabel,
} from '@/features/wishlist/deal-radar';

export type DealRadarBandProps = {
  alerts: readonly DealAlert[];
  /**
   * The watched cards, by `watchKey` (card + printing) and by bare card id as a
   * fallback. The alert carries its own name and art, so this only ENRICHES a
   * row (set name, collector number, currency) — a deal whose card has left the
   * watchlist still renders.
   */
  cardsById: ReadonlyMap<string, CardFavoriteEntry>;
  /** Swipe left → Dismiss hides the deal for good. */
  onDismissDeal: (id: string) => void;
  onMarkSeen: (id: string) => void;
  onOpenDeal: (alert: DealAlert, card: CardFavoriteEntry | null) => void;
  onShareDeal: (alert: DealAlert, card: CardFavoriteEntry | null) => void;
  /** Gutter/margin, owned by the caller — see the empty-state note below. */
  style?: StyleProp<ViewStyle>;
  unseenCount: number;
};

const UNSEEN_DOT_SIZE = 8;

type ResolvedDeal = { alert: DealAlert; card: CardFavoriteEntry | null; name: string };

/**
 * The Deals band: the caught-listing surface that sits ABOVE the watchlist rows.
 *
 * Deliberately NOT a pill on the rows. Trend pills and sparklines were taken off
 * watchlist rows on purpose (see the note on the row's `trendChangePercent`),
 * and a deal is a different kind of claim anyway — it is an event with a link,
 * not a property of the card. It gets its own surface or it gets nothing.
 *
 * EMPTY MEANS ABSENT. No empty card, no "no deals yet" box: a band that is
 * visible while silent trains people to stop reading it. It appears only when
 * it has something to say — which is why the caller's gutter/margin arrives as
 * `style` on THIS view rather than on a wrapper: an empty wrapper still spends
 * its margin.
 *
 * Its unread dot lives HERE rather than on the notification bell. That badge is
 * Supabase-backed and social-only — its renderable types are a fixed list
 * written by `security definer` triggers with no client insert path — and deal
 * alerts come from the backend API instead.
 */
export function DealRadarBand({
  alerts,
  cardsById,
  onDismissDeal,
  onMarkSeen,
  onOpenDeal,
  onShareDeal,
  style,
  unseenCount,
}: DealRadarBandProps) {
  const theme = useSpotlightTheme();

  // The alert names itself, so the watchlist entry is enrichment, not a gate —
  // un-watching a card must not silently delete the deal you were told about.
  // Only a deal with no name anywhere is dropped, since that row says nothing.
  const resolved: ResolvedDeal[] = [];
  for (const alert of alerts) {
    const card = cardsById.get(buildWatchKey(alert.cardId, alert.variantKey))
      ?? cardsById.get(alert.cardId)
      ?? null;
    const name = (card?.name ?? alert.cardName ?? '').trim();
    if (name) {
      resolved.push({ alert, card, name });
    }
  }

  if (resolved.length === 0) {
    return null;
  }

  const unseen = Math.min(unseenCount, resolved.length);

  return (
    <View style={[styles.band, style]} testID="wishlist-deal-band">
      <SectionHeader
        countText={resolved.length === 1 ? '1 listing caught' : `${resolved.length} listings caught`}
        size="compact"
        testID="wishlist-deal-band-header"
        title="Deals"
        titleAccessory={unseen > 0 ? (
          <View
            accessibilityLabel={`${unseen} new deals`}
            style={[styles.unseenDot, { backgroundColor: theme.colors.brandStrong }]}
            testID="wishlist-deal-band-unseen-dot"
          />
        ) : null}
      />

      <View style={styles.rows}>
        {resolved.map(({ alert, card, name }) => (
          <DealRadarRow
            alert={alert}
            card={card}
            key={alert.id}
            name={name}
            onDismissDeal={onDismissDeal}
            onMarkSeen={onMarkSeen}
            onOpenDeal={onOpenDeal}
            onShareDeal={onShareDeal}
          />
        ))}
      </View>
    </View>
  );
}

type DealRadarRowProps = {
  alert: DealAlert;
  /** null once the card leaves the watchlist; the alert still names itself. */
  card: CardFavoriteEntry | null;
  name: string;
  onDismissDeal: (id: string) => void;
  onMarkSeen: (id: string) => void;
  onOpenDeal: (alert: DealAlert, card: CardFavoriteEntry | null) => void;
  onShareDeal: (alert: DealAlert, card: CardFavoriteEntry | null) => void;
};

function DealRadarRow({
  alert,
  card,
  name,
  onDismissDeal,
  onMarkSeen,
  onOpenDeal,
  onShareDeal,
}: DealRadarRowProps) {
  const theme = useSpotlightTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const currencyCode = card?.currencyCode ?? 'USD';
  // Prefer the watchlist entry's art (already cached by the rows below); fall
  // back to the thumbnail the alert carries for a card no longer watched.
  const artSource = card ? getCardImageSource(card, 'small') : alert.imageUrl ? { uri: alert.imageUrl } : undefined;
  const headline = buildDealHeadline(alert, currencyCode);
  const discountLabel = buildDiscountLabel(alert);
  const tierLabel = buildTierLabel(alert);
  const printing = (alert.variantKey ?? '').trim() || null;
  const alertId = alert.id;
  const alreadySeen = alert.seenAt != null;

  // Seen fires when the deal first REACHES the screen, not when the page loads:
  // the band is the only place a deal is ever shown, so a mounted row is the
  // honest definition of "seen". The hook de-dupes per id.
  useEffect(() => {
    if (!alreadySeen) {
      onMarkSeen(alertId);
    }
  }, [alertId, alreadySeen, onMarkSeen]);

  // Same swipe-left rail as the watchlist rows, shaped to the card.
  const renderRightActions = () => (
    <Pressable
      accessibilityLabel={`Dismiss this ${name} deal`}
      accessibilityRole="button"
      onPress={() => {
        swipeableRef.current?.close();
        onDismissDeal(alertId);
      }}
      style={[
        styles.dismissAction,
        { backgroundColor: theme.colors.dangerStrong, borderRadius: theme.radii.md },
      ]}
      testID={`wishlist-deal-dismiss-${alertId}`}
    >
      <Xmark color={theme.colors.gray0} height={20} width={20} />
      <Text style={[theme.typography.caption, { color: theme.colors.gray0 }]}>Dismiss</Text>
    </Pressable>
  );

  return (
    <Swipeable
      activeOffsetX={-15}
      friction={1.5}
      overshootRight={false}
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
    >
      <Pressable
        accessibilityLabel={`${name} — ${headline}`}
        accessibilityRole="button"
        onPress={() => onOpenDeal(alert, card)}
        testID={`wishlist-deal-row-${alert.id}`}
      >
        <SurfaceCard
          padding={spacing.xs}
          radius={theme.radii.md}
          style={styles.card}
          testID={`wishlist-deal-card-${alert.id}`}
          variant="elevated"
        >
          <View style={styles.row}>
            <View
              style={[styles.artFrame, { backgroundColor: theme.colors.field }]}
              testID={`wishlist-deal-art-frame-${alert.id}`}
            >
              <CachedImage
                cachePolicy={imageCachePolicy.thumbnail}
                contentFit="cover"
                source={artSource}
                style={StyleSheet.absoluteFill}
                testID={`wishlist-deal-art-${alert.id}`}
              />
            </View>

            <View style={styles.copy}>
              <Text
                numberOfLines={1}
                style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}
                testID={`wishlist-deal-name-${alert.id}`}
              >
                {name}
              </Text>
              {printing ? (
                <Text
                  numberOfLines={1}
                  style={[theme.typography.label, { color: theme.colors.gray600 }]}
                  testID={`wishlist-deal-printing-${alert.id}`}
                >
                  {printing}
                </Text>
              ) : null}
              <Text
                numberOfLines={2}
                style={[theme.typography.label, { color: theme.colors.gray600 }]}
                testID={`wishlist-deal-headline-${alert.id}`}
              >
                {headline}
              </Text>
              {discountLabel || tierLabel ? (
                <View style={styles.chips}>
                  {discountLabel ? (
                    // A discount only exists when it is > 0, so this is the green tone.
                    <DeltaPill
                      changePercent={alert.discountPct}
                      label={discountLabel}
                      testID={`wishlist-deal-discount-${alert.id}`}
                    />
                  ) : null}
                  {tierLabel ? (
                    // Neutral tone on purpose: a caveat on the claim, not a second claim.
                    <DeltaPill
                      changePercent={null}
                      label={tierLabel}
                      testID={`wishlist-deal-tier-${alert.id}`}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>

            <IconButton
              accessibilityLabel={`Share this ${name} deal`}
              onPress={() => onShareDeal(alert, card)}
              testID={`wishlist-deal-share-${alert.id}`}
              variant="subtle"
            >
              <ShareIos
                color={theme.colors.gray900}
                height={iconButtonDefaultGlyphSize}
                width={iconButtonDefaultGlyphSize}
              />
            </IconButton>
          </View>
        </SurfaceCard>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  // The watchlist list row's own art slot (`CardListRow`: 58x80, raw-art
  // radius, field fill, no stroke) so a deal reads as the same card. Not the
  // primitive itself: card art here goes through `CachedImage` (expo-image).
  artFrame: {
    borderCurve: 'continuous',
    borderRadius: layout.inventoryArtRadiusRaw,
    height: layout.rowThumbnailHeight,
    overflow: 'hidden',
    width: layout.rowThumbnailWidth,
  },
  band: {
    gap: spacing.xs,
  },
  // `CardListRow`'s insets: 16 across, 12 down.
  card: {
    paddingHorizontal: spacing.sm,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xxxs,
  },
  copy: {
    alignItems: 'flex-start',
    flex: 1,
    gap: spacing.xxxs,
  },
  // Same rail as the watchlist row's Delete, with the card's radius.
  dismissAction: {
    alignItems: 'center',
    borderCurve: 'continuous',
    gap: spacing.xxxs,
    justifyContent: 'center',
    marginLeft: spacing.xxs,
    width: layout.swipeActionWidth,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    // Thumb <-> copy gap matches `CardListRow`.
    gap: spacing.xxs,
  },
  rows: {
    gap: spacing.xxs,
  },
  unseenDot: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: UNSEEN_DOT_SIZE,
    width: UNSEEN_DOT_SIZE,
  },
});
