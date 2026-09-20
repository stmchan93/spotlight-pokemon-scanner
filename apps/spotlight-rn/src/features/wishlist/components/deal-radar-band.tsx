import { useEffect } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ShareIos } from 'iconoir-react-native';

import type { CardFavoriteEntry, DealAlert } from '@spotlight/api-client';
import {
  IconButton,
  SurfaceCard,
  Text,
  radii,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import { buildDealHeadline, buildDiscountLabel } from '@/features/wishlist/deal-radar';

export type DealRadarBandProps = {
  alerts: readonly DealAlert[];
  /** The watched cards, by id — the deal payload carries no name or art. */
  cardsById: ReadonlyMap<string, CardFavoriteEntry>;
  onMarkSeen: (id: string) => void;
  onOpenDeal: (alert: DealAlert, card: CardFavoriteEntry) => void;
  onShareDeal: (alert: DealAlert, card: CardFavoriteEntry) => void;
  /** Gutter/margin, owned by the caller — see the empty-state note below. */
  style?: StyleProp<ViewStyle>;
  unseenCount: number;
};

type ResolvedDeal = { alert: DealAlert; card: CardFavoriteEntry };

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
  onMarkSeen,
  onOpenDeal,
  onShareDeal,
  style,
  unseenCount,
}: DealRadarBandProps) {
  const theme = useSpotlightTheme();

  // A deal we cannot name is a row that says nothing: the payload carries only
  // `cardId`, so a deal for a card that has left the watchlist is dropped
  // rather than rendered as an anonymous price.
  const resolved: ResolvedDeal[] = [];
  for (const alert of alerts) {
    const card = cardsById.get(alert.cardId);
    if (card) {
      resolved.push({ alert, card });
    }
  }

  if (resolved.length === 0) {
    return null;
  }

  const unseen = Math.min(unseenCount, resolved.length);

  return (
    <View style={[styles.band, style]} testID="wishlist-deal-band">
      <View style={styles.header}>
        <Text style={theme.typography.titleSmall}>Deals</Text>
        {unseen > 0 ? (
          <View
            accessibilityLabel={`${unseen} new deals`}
            style={[styles.unseenDot, { backgroundColor: theme.colors.brandStrong }]}
            testID="wishlist-deal-band-unseen-dot"
          />
        ) : null}
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
          {resolved.length === 1 ? '1 listing caught' : `${resolved.length} listings caught`}
        </Text>
      </View>

      <View style={styles.rows}>
        {resolved.map(({ alert, card }) => (
          <DealRadarRow
            alert={alert}
            card={card}
            key={alert.id}
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
  card: CardFavoriteEntry;
  onMarkSeen: (id: string) => void;
  onOpenDeal: (alert: DealAlert, card: CardFavoriteEntry) => void;
  onShareDeal: (alert: DealAlert, card: CardFavoriteEntry) => void;
};

function DealRadarRow({ alert, card, onMarkSeen, onOpenDeal, onShareDeal }: DealRadarRowProps) {
  const theme = useSpotlightTheme();
  const currencyCode = card.currencyCode ?? 'USD';
  const headline = buildDealHeadline(alert, currencyCode);
  const discountLabel = buildDiscountLabel(alert);
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

  return (
    <Pressable
      accessibilityLabel={`${card.name} — ${headline}`}
      accessibilityRole="button"
      onPress={() => onOpenDeal(alert, card)}
      testID={`wishlist-deal-row-${alert.id}`}
    >
      <SurfaceCard padding={12} radius={theme.radii.md} variant="elevated">
        <View style={styles.row}>
          <View
            style={[
              styles.artFrame,
              {
                backgroundColor: theme.colors.field,
                borderColor: theme.colors.outlineSubtle,
              },
            ]}
          >
            <CachedImage
              cachePolicy={imageCachePolicy.thumbnail}
              contentFit="cover"
              source={getCardImageSource(card, 'small')}
              style={StyleSheet.absoluteFill}
              testID={`wishlist-deal-art-${alert.id}`}
            />
          </View>

          <View style={styles.copy}>
            <Text numberOfLines={1} style={theme.typography.bodyMedium}>
              {card.name}
            </Text>
            <Text
              numberOfLines={2}
              style={[theme.typography.caption, { color: theme.colors.gray600 }]}
              testID={`wishlist-deal-headline-${alert.id}`}
            >
              {headline}
            </Text>
            {discountLabel ? (
              <View
                style={[styles.discountChip, { backgroundColor: theme.colors.deltaUpSurface }]}
              >
                <Text
                  style={[theme.typography.deltaPill, { color: theme.colors.deltaUpText }]}
                  testID={`wishlist-deal-discount-${alert.id}`}
                >
                  {discountLabel}
                </Text>
              </View>
            ) : null}
          </View>

          <IconButton
            accessibilityLabel={`Share this ${card.name} deal`}
            onPress={() => onShareDeal(alert, card)}
            size={34}
            testID={`wishlist-deal-share-${alert.id}`}
            variant="subtle"
          >
            <ShareIos color={theme.colors.gray900} height={17} width={17} />
          </IconButton>
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // `CardThumbnail`'s own `sm` metrics (44x60, radii.sm). Not the primitive
  // itself: it takes an RN image source, and card art goes through
  // `CachedImage` (expo-image) everywhere else in the app.
  artFrame: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 1,
    height: 60,
    overflow: 'hidden',
    width: 44,
  },
  band: {
    gap: 12,
  },
  copy: {
    alignItems: 'flex-start',
    flex: 1,
    gap: 4,
  },
  discountChip: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  rows: {
    gap: 8,
  },
  unseenDot: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: 8,
    width: 8,
  },
});
