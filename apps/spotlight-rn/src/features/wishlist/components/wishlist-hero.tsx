import { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  View,
  type PanResponderGestureState,
} from 'react-native';
import {
  ArrowDown,
  ArrowUp,
  Menu as MenuIcon,
  Upload as ShareIcon,
  Xmark,
} from 'iconoir-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import { AppText, IconButton, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Card image is rendered at a fixed portrait size centred over the grey backdrop.
const CARD_WIDTH = 165;
const CARD_HEIGHT = 240;
// How far the card can slide during a drag, for a gentle parallax (not a swipe).
const PARALLAX_MAX = 36;
// A release that never travelled past this is treated as a tap → open detail.
const TAP_SLOP = 6;

const DELTA_UP_BACKGROUND = '#E2F4E8';
const DELTA_DOWN_BACKGROUND = '#FFE9E9';

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildMetaLine(cardNumber: string | null | undefined, setName: string | null | undefined) {
  const number = (cardNumber ?? '').trim();
  const set = (setName ?? '').trim();
  if (number && set) {
    return `${number} · ${set}`;
  }
  return number || set || '';
}

function gradeLabelFor(entry: CardFavoriteEntry): string | null {
  if (entry.slabContext) {
    const grader = (entry.slabContext.grader ?? '').trim();
    const grade = (entry.slabContext.grade ?? '').trim();
    const combined = [grader, grade].filter(Boolean).join(' ');
    if (combined.length > 0) {
      return combined;
    }
  }
  const short = (entry.conditionShortLabel ?? '').trim();
  return short.length > 0 ? short : null;
}

type WishlistHeroProps = {
  /** Featured card, or null while the list is empty/loading (header only). */
  entry: CardFavoriteEntry | null;
  onOpenMenu: () => void;
  onShare?: () => void;
  onOpenDetail: () => void;
  /** Remove the featured card from the wishlist (the top-right X). */
  onRemove?: () => void;
  testID?: string;
};

export function WishlistHero({
  entry,
  onOpenMenu,
  onShare,
  onOpenDetail,
  onRemove,
  testID = 'wishlist-hero',
}: WishlistHeroProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const imageSource = entry ? getCardImageSource(entry, 'large') : null;

  // With a featured card the grey backdrop bleeds up under the status bar +
  // header and frames the card; with no card it only tints the header strip so
  // the empty state still reads as one screen.
  const backdropHeight = entry ? insets.top + 332 : insets.top + 64;

  const dragX = useRef(new Animated.Value(0)).current;
  // Settle the parallax back to centre whenever the featured card changes.
  useEffect(() => {
    dragX.setValue(0);
  }, [dragX, entry?.cardId]);

  const springBack = () => {
    // Must be JS-driven: `dragX` is updated with setValue() in onPanResponderMove,
    // and an Animated.Value cannot be driven by both the native and JS drivers.
    Animated.spring(dragX, {
      bounciness: 6,
      speed: 14,
      toValue: 0,
      useNativeDriver: false,
    }).start();
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 4,
        onPanResponderMove: (_, gesture: PanResponderGestureState) => {
          dragX.setValue(clamp(gesture.dx * 0.6, -PARALLAX_MAX, PARALLAX_MAX));
        },
        onPanResponderRelease: (_, gesture: PanResponderGestureState) => {
          if (Math.abs(gesture.dx) < TAP_SLOP && Math.abs(gesture.dy) < TAP_SLOP) {
            onOpenDetail();
          }
          springBack();
        },
        onPanResponderTerminate: () => {
          springBack();
        },
      }),
    // springBack is stable (closes over refs only); dragX/onOpenDetail drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragX, onOpenDetail],
  );

  const metaLine = entry ? buildMetaLine(entry.cardNumber, entry.setName) : '';
  const gradeText = entry ? gradeLabelFor(entry) : null;
  const trend =
    entry && typeof entry.dayChangeAmount === 'number' && Number.isFinite(entry.dayChangeAmount)
      ? entry.dayChangeAmount
      : 0;
  const showTrend = trend !== 0;
  const trendIsDown = trend < 0;
  const trendColor = trendIsDown ? theme.colors.deltaDownText : theme.colors.deltaUpText;

  return (
    <View style={styles.root} testID={testID}>
      <View
        pointerEvents="none"
        style={[styles.backdrop, { backgroundColor: theme.colors.gray50, height: backdropHeight }]}
        testID={`${testID}-backdrop`}
      />

      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <IconButton
          accessibilityLabel="Open menu"
          onPress={onOpenMenu}
          size={36}
          testID="wishlist-header-menu"
          variant="elevated"
        >
          <MenuIcon color={theme.colors.gray900} height={20} width={20} />
        </IconButton>
        <AppText
          color="textPrimary"
          numberOfLines={1}
          style={styles.headerTitle}
          testID="wishlist-header-title"
          variant="titleMedium"
        >
          Wishlist
        </AppText>
        <IconButton
          accessibilityLabel="Share wishlist"
          onPress={onShare}
          size={36}
          testID="wishlist-header-share"
          variant="elevated"
        >
          <ShareIcon color={theme.colors.gray900} height={18} width={18} />
        </IconButton>
      </View>

      {entry ? (
        <View style={styles.cardArea}>
          <Animated.View
            style={[styles.cardWrap, { transform: [{ translateX: dragX }] }]}
            testID={`${testID}-card`}
            {...panResponder.panHandlers}
          >
            <View style={styles.cardShadow}>
              {imageSource ? (
                <CachedImage
                  accessibilityLabel={entry.name}
                  cachePolicy={imageCachePolicy.hero}
                  contentFit="contain"
                  source={imageSource}
                  style={styles.cardImage}
                  testID={`${testID}-card-image`}
                />
              ) : (
                <View
                  style={[styles.cardFallback, { backgroundColor: theme.colors.field }]}
                  testID={`${testID}-card-fallback`}
                >
                  <AppText color="textSecondary" numberOfLines={2} variant="caption">
                    {entry.name}
                  </AppText>
                </View>
              )}
            </View>
          </Animated.View>

          {onRemove ? (
            <IconButton
              accessibilityLabel="Remove from wishlist"
              onPress={onRemove}
              size={28}
              style={styles.removeButton}
              testID={`${testID}-remove`}
              variant="elevated"
            >
              <Xmark color={theme.colors.gray600} height={16} width={16} />
            </IconButton>
          ) : null}
        </View>
      ) : null}

      {entry ? (
        <View style={[styles.detailRow, { paddingHorizontal: theme.layout.pageGutter }]}>
          <View style={styles.detailLeft}>
            <AppText color="gray900" numberOfLines={1} variant="titleLarge">
              {entry.name}
            </AppText>
            {metaLine ? (
              <AppText color="gray600" numberOfLines={1} variant="bodyMedium">
                {metaLine}
              </AppText>
            ) : null}
            {gradeText ? (
              <AppText color="gray600" numberOfLines={1} variant="bodyMedium">
                {gradeText}
              </AppText>
            ) : null}
          </View>
          <View style={styles.detailRight}>
            <AppText
              color="gray900"
              numberOfLines={1}
              testID={`${testID}-price`}
              variant="titleSmall"
            >
              {formatOptionalCurrency(entry.marketPrice, entry.currencyCode)}
            </AppText>
            {showTrend ? (
              <View
                style={[
                  styles.trendPill,
                  {
                    backgroundColor: trendIsDown ? DELTA_DOWN_BACKGROUND : DELTA_UP_BACKGROUND,
                  },
                ]}
                testID={`${testID}-trend`}
              >
                {trendIsDown ? (
                  <ArrowDown color={trendColor} height={12} width={12} />
                ) : (
                  <ArrowUp color={trendColor} height={12} width={12} />
                )}
                <AppText numberOfLines={1} style={[styles.trendLabel, { color: trendColor }]} variant="label">
                  {formatOptionalCurrency(Math.abs(trend), entry.currencyCode)}
                </AppText>
              </View>
            ) : null}
            <AppText color="gray600" numberOfLines={1} variant="label">
              Qty: 1
            </AppText>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'relative',
  },
  backdrop: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
  cardArea: {
    alignSelf: 'center',
    marginTop: 20,
    position: 'relative',
    width: CARD_WIDTH,
  },
  cardWrap: {
    alignItems: 'center',
  },
  cardShadow: {
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
  },
  cardImage: {
    height: CARD_HEIGHT,
    width: CARD_WIDTH,
  },
  cardFallback: {
    alignItems: 'center',
    borderRadius: 8,
    height: CARD_HEIGHT,
    justifyContent: 'center',
    padding: 12,
    width: CARD_WIDTH,
  },
  // Floating remove control on the card's top-right corner.
  removeButton: {
    position: 'absolute',
    right: -6,
    top: -6,
  },
  detailRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    // The grey hero backdrop ends 28px below the card (card bottom + the 28px
    // pad baked into `backdropHeight`). Drop the product card a further 16px so
    // it sits cleanly on white, 16px below the panel (Figma 1263-3543 @ y+16),
    // instead of overlapping the grey edge.
    marginTop: 44,
  },
  detailLeft: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  detailRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  trendPill: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  trendLabel: {
    // color overridden inline
  },
});
