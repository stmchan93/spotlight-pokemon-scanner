import { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  View,
  type PanResponderGestureState,
} from 'react-native';
import { ArrowDown, ArrowUp, Menu as MenuIcon, Upload as ShareIcon } from 'iconoir-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import { AppText, IconButton, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import { useImageDominantColor } from '@/lib/use-image-dominant-color';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Card image is rendered at a fixed portrait size centred over the gradient.
const CARD_WIDTH = 165;
const CARD_HEIGHT = 240;
// How far the card can slide during a drag; the gradient counter-shifts a
// little for depth. Tuned to feel like a gentle parallax, not a swipe.
const PARALLAX_MAX = 36;
const GRADIENT_SHIFT = 12;
// A release that never travelled past this is treated as a tap → open detail.
const TAP_SLOP = 6;

const DELTA_UP_BACKGROUND = 'rgba(76, 175, 110, 0.15)';
const DELTA_DOWN_BACKGROUND = 'rgba(224, 82, 76, 0.15)';

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
  testID?: string;
};

export function WishlistHero({
  entry,
  onOpenMenu,
  onShare,
  onOpenDetail,
  testID = 'wishlist-hero',
}: WishlistHeroProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const imageSource = entry ? getCardImageSource(entry, 'large') : null;
  const imageUri = imageSource?.uri ?? null;
  const { color } = useImageDominantColor(imageUri);

  // With a featured card the gradient bleeds up under the status bar + header
  // and fades to white around the detail row; with no card it only tints the
  // header strip so the empty state still reads as one screen.
  const backdropHeight = entry ? insets.top + 332 : insets.top + 64;

  const dragX = useRef(new Animated.Value(0)).current;
  // Soft settle whenever the featured card (and thus the color) changes, so the
  // gradient doesn't hard-cut between cards.
  const backdropOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    backdropOpacity.setValue(0.4);
    Animated.timing(backdropOpacity, {
      duration: 260,
      toValue: 1,
      useNativeDriver: true,
    }).start();
    dragX.setValue(0);
  }, [backdropOpacity, color, dragX, entry?.cardId]);

  const springBack = () => {
    Animated.spring(dragX, {
      bounciness: 6,
      speed: 14,
      toValue: 0,
      useNativeDriver: true,
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

  const gradientTranslate = dragX.interpolate({
    extrapolate: 'clamp',
    inputRange: [-PARALLAX_MAX, PARALLAX_MAX],
    outputRange: [GRADIENT_SHIFT, -GRADIENT_SHIFT],
  });

  const metaLine = entry ? buildMetaLine(entry.cardNumber, entry.setName) : '';
  const gradeText = entry ? gradeLabelFor(entry) : null;
  const trend =
    entry && typeof entry.dayChangeAmount === 'number' && Number.isFinite(entry.dayChangeAmount)
      ? entry.dayChangeAmount
      : 0;
  const showTrend = trend !== 0;
  const trendIsDown = trend < 0;
  const trendColor = trendIsDown ? theme.colors.redDelta : theme.colors.greenDelta;

  return (
    <View style={styles.root} testID={testID}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.backdrop,
          {
            height: backdropHeight,
            opacity: backdropOpacity,
            transform: [{ translateX: gradientTranslate }],
          },
        ]}
        testID={`${testID}-gradient`}
      >
        <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 100 100" width="100%">
          <Defs>
            <LinearGradient
              gradientUnits="userSpaceOnUse"
              id="wishlist-hero-gradient"
              x1="50"
              x2="50"
              y1="0"
              y2="100"
            >
              <Stop offset="0" stopColor={color} stopOpacity={1} />
              <Stop offset="0.3" stopColor={color} stopOpacity={0.82} />
              <Stop offset="0.66" stopColor={color} stopOpacity={0.45} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect fill="url(#wishlist-hero-gradient)" height="100" width="100" x="0" y="0" />
        </Svg>
      </Animated.View>

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
      ) : null}

      {entry ? (
        <View style={[styles.detailRow, { paddingHorizontal: theme.layout.pageGutter }]}>
          <View style={styles.detailLeft}>
            <AppText color="textPrimary" numberOfLines={1} variant="bodyStrong">
              {entry.name}
            </AppText>
            {metaLine ? (
              <AppText color="textSecondary" numberOfLines={1} variant="caption">
                {metaLine}
              </AppText>
            ) : null}
            {gradeText ? (
              <AppText color="textMuted" numberOfLines={1} variant="caption">
                {gradeText}
              </AppText>
            ) : null}
          </View>
          <View style={styles.detailRight}>
            <AppText
              color="textPrimary"
              numberOfLines={1}
              testID={`${testID}-price`}
              variant="bodyStrong"
            >
              {formatOptionalCurrency(entry.marketPrice, entry.currencyCode)}
            </AppText>
            {showTrend ? (
              <View
                style={[
                  styles.trendPill,
                  {
                    backgroundColor: trendIsDown ? DELTA_DOWN_BACKGROUND : DELTA_UP_BACKGROUND,
                    borderRadius: theme.radii.pill,
                  },
                ]}
                testID={`${testID}-trend`}
              >
                {trendIsDown ? (
                  <ArrowDown color={trendColor} height={12} width={12} />
                ) : (
                  <ArrowUp color={trendColor} height={12} width={12} />
                )}
                <AppText numberOfLines={1} style={{ color: trendColor }} variant="caption">
                  {formatOptionalCurrency(Math.abs(trend), entry.currencyCode)}
                </AppText>
              </View>
            ) : null}
            <AppText color="textMuted" numberOfLines={1} variant="caption">
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
  cardWrap: {
    alignItems: 'center',
    marginTop: 20,
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
  detailRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 18,
  },
  detailLeft: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  detailRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  trendPill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
