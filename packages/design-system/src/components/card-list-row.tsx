import { ArrowDown, ArrowUp } from 'iconoir-react-native';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { PriceSparkline } from './price-sparkline';
import { SelectionCheckCircle } from './selection-check-circle';
import { SlabFrame } from './slab-frame';

export type CardListRowProps = {
  imageUrl: string | null;
  name: string;
  cardNumber?: string | null;
  setName?: string | null;
  gradeLabel?: string | null;
  /**
   * Slab identity for the THUMBNAIL's slab-case frame (Figma 2609:6812 — the
   * card art sits inside its grading slab with the grader's label band on
   * top). Keyed by THIS entry's grader. The grade TEXT line stays `gradeLabel`
   * ("PSA 10", plain gray) — the frame only affects the image.
   */
  grader?: string | null;
  grade?: string | null;
  marketPrice: number | null;
  currencyCode?: string;
  trendChangeAmount?: number | null;
  /**
   * Optional percent companion to `trendChangeAmount` — when present (and
   * finite) the pill reads `$142.00 (31.00%)` instead of just the amount.
   * Percent formatting matches the portfolio balance header (two decimals,
   * unsigned; the arrow carries the direction).
   */
  trendChangePercent?: number | null;
  /**
   * Small gray caption rendered directly under the trend pill (e.g.
   * "since added") so the pill's time span reads truthfully. Only shown when
   * the pill itself is shown.
   */
  trendCaption?: string;
  /**
   * Market-price series (oldest → newest) for a 62×22 sparkline between the
   * name/set copy and the price column: [thumb][name/set][sparkline][price].
   * Absent/empty → no sparkline, layout identical to before.
   */
  sparkPoints?: number[];
  /**
   * Percent change across `sparkPoints`; tints the sparkline green (>= 0) or
   * red (< 0). The sparkline tint is independent of the trend pill — the pill
   * carries the since-added truth, the sparkline its own 30d direction.
   */
  sparkTrendPct?: number | null;
  quantity: number;
  /**
   * When false, the "Qty: N" line is hidden — e.g. wishlist rows, which have no
   * quantity concept. Defaults to true (collection rows show it).
   */
  showQuantity?: boolean;
  /**
   * When false, the card thumbnail is omitted and the text stack sits flush
   * left (wishlist list row, Figma 992:10052). Defaults to true.
   */
  showThumbnail?: boolean;
  /**
   * When true, the row draws a top hairline in addition to its bottom hairline.
   * Pass this only for the first row in a list so rows share single 1px
   * dividers (each row's bottom border) with a top border framing the list,
   * instead of stacking two borders between adjacent rows.
   */
  firstInSection?: boolean;
  /**
   * Selection state for the leading check-circle (only rendered when
   * `selectable` is true).
   */
  selected?: boolean;
  /**
   * When true, a selection check-circle renders as a leading element on the far
   * left of the row (before the thumbnail) reflecting `selected`. Used for
   * multi-select edit mode.
   */
  selectable?: boolean;
  onPress?: () => void;
  /** Long-press handler (e.g. opens the card actions menu). */
  onLongPress?: () => void;
  /** Long-press delay in ms; defaults to the Pressable default (~500). */
  delayLongPress?: number;
  testID?: string;
};

const THUMBNAIL_WIDTH = 58;
const THUMBNAIL_HEIGHT = 80;
const THUMBNAIL_RADIUS = 2;
// Slab rows show the whole slab (case + label) in a 50×80 slot (Figma
// 2566:6390) — same 80pt row height as raw thumbs, narrower for the slab's
// taller aspect. (84×136 is the card-detail-size slot, Figma 2609:6977.)
const SLAB_THUMBNAIL_WIDTH = 50;
const SLAB_THUMBNAIL_HEIGHT = 80;

function formatCurrency(amount: number, currencyCode: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function buildMetaLine(cardNumber: string | null | undefined, setName: string | null | undefined) {
  const number = (cardNumber ?? '').trim();
  const set = (setName ?? '').trim();
  if (number && set) {
    return `${number} · ${set}`;
  }
  return number || set || '';
}

export function CardListRow({
  imageUrl,
  name,
  cardNumber,
  setName,
  gradeLabel,
  grader,
  grade,
  marketPrice,
  currencyCode = 'USD',
  trendChangeAmount,
  trendChangePercent,
  trendCaption,
  sparkPoints,
  sparkTrendPct,
  quantity,
  showQuantity = true,
  showThumbnail = true,
  firstInSection = false,
  selected = false,
  selectable = false,
  onPress,
  onLongPress,
  delayLongPress,
  testID,
}: CardListRowProps) {
  const theme = useSpotlightTheme();

  const borderStyle = {
    borderBottomColor: theme.colors.gray100,
    ...(firstInSection
      ? { borderTopColor: theme.colors.gray100, borderTopWidth: 1 }
      : null),
  };

  const metaLine = buildMetaLine(cardNumber, setName);
  const gradeText = (gradeLabel ?? '').trim();
  // Slab-case frame on the thumbnail — keyed by THIS entry's grader.
  const graderText = (grader ?? '').trim();
  const showSlabFrame = showThumbnail && graderText.length > 0;
  const hasPrice = marketPrice !== null && Number.isFinite(marketPrice);
  const trend = typeof trendChangeAmount === 'number' && Number.isFinite(trendChangeAmount)
    ? trendChangeAmount
    : 0;
  const showTrend = trend !== 0;
  const trendIsDown = trend < 0;
  const trendColor = trendIsDown ? theme.colors.deltaDownText : theme.colors.deltaUpText;
  const trendBackground = trendIsDown ? theme.colors.deltaDownSurface : theme.colors.deltaUpSurface;
  // Unsigned percent companion (the arrow carries the direction), matching the
  // balance header's two-decimal formatting. Hidden when absent/non-finite.
  const trendPercent = typeof trendChangePercent === 'number' && Number.isFinite(trendChangePercent)
    ? trendChangePercent
    : null;
  const trendLabel = trendPercent !== null
    ? `${formatCurrency(Math.abs(trend), currencyCode)} (${Math.abs(trendPercent).toFixed(2)}%)`
    : formatCurrency(Math.abs(trend), currencyCode);
  const showSparkline = Array.isArray(sparkPoints) && sparkPoints.length > 0;

  const Container = onPress ? Pressable : View;
  const containerProps = onPress
    ? {
        accessibilityRole: 'button' as const,
        onPress,
        onLongPress,
        delayLongPress,
        style: ({ pressed }: { pressed: boolean }) => [
          styles.row,
          {
            backgroundColor: theme.colors.gray0,
            ...borderStyle,
            opacity: pressed ? 0.82 : 1,
          },
        ],
        testID,
      }
    : {
        style: [
          styles.row,
          {
            backgroundColor: theme.colors.gray0,
            ...borderStyle,
          },
        ],
        testID,
      };

  return (
    <Container {...containerProps}>
      {selectable ? (
        <View
          style={styles.selectLeading}
          testID={testID ? `${testID}-select` : undefined}
        >
          <SelectionCheckCircle selected={!!selected} />
        </View>
      ) : null}

      {showSlabFrame ? (
        <View style={styles.slabThumbnail} testID={testID ? `${testID}-thumbnail` : undefined}>
          <SlabFrame
            cardNumber={cardNumber}
            grade={grade}
            grader={graderText}
            setLine={setName}
            size="sm"
            testID={testID ? `${testID}-slab-frame` : undefined}
            title={name}
          >
            {imageUrl ? (
              <Image
                accessibilityIgnoresInvertColors
                resizeMode="cover"
                source={{ uri: imageUrl }}
                style={StyleSheet.absoluteFill}
                testID={testID ? `${testID}-image` : undefined}
              />
            ) : (
              <View
                style={[styles.thumbnailPlaceholder, { backgroundColor: theme.colors.field }]}
                testID={testID ? `${testID}-thumbnail-placeholder` : undefined}
              >
                <AppText color="textSecondary" variant="micro">
                  CARD
                </AppText>
              </View>
            )}
          </SlabFrame>
        </View>
      ) : showThumbnail ? (
        <View
          style={[
            styles.thumbnail,
            {
              backgroundColor: theme.colors.field,
              borderRadius: THUMBNAIL_RADIUS,
            },
          ]}
          testID={testID ? `${testID}-thumbnail` : undefined}
        >
          {imageUrl ? (
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="cover"
              source={{ uri: imageUrl }}
              style={[StyleSheet.absoluteFill, { borderRadius: THUMBNAIL_RADIUS }]}
              testID={testID ? `${testID}-image` : undefined}
            />
          ) : (
            <View
              style={styles.thumbnailPlaceholder}
              testID={testID ? `${testID}-thumbnail-placeholder` : undefined}
            >
              <AppText color="textSecondary" variant="micro">
                CARD
              </AppText>
            </View>
          )}
        </View>
      ) : null}

      <View style={styles.middle}>
        <AppText color="gray900" numberOfLines={1} variant="titleSmall">
          {name}
        </AppText>
        {metaLine ? (
          <AppText color="gray600" numberOfLines={1} variant="label">
            {metaLine}
          </AppText>
        ) : null}
        {gradeText ? (
          <AppText color="gray600" numberOfLines={1} variant="label">
            {gradeText}
          </AppText>
        ) : null}
      </View>

      {showSparkline ? (
        <PriceSparkline
          points={sparkPoints ?? []}
          testID={testID ? `${testID}-sparkline` : undefined}
          trendPct={sparkTrendPct}
        />
      ) : null}

      <View style={styles.right}>
        {hasPrice ? (
          <AppText
            color="gray900"
            numberOfLines={1}
            style={styles.priceText}
            testID={testID ? `${testID}-price` : undefined}
            variant="bodyStrong"
          >
            {formatCurrency(marketPrice as number, currencyCode)}
          </AppText>
        ) : null}

        {showTrend ? (
          <View
            style={[styles.trendPill, { backgroundColor: trendBackground }]}
            testID={testID ? `${testID}-trend` : undefined}
          >
            {trendIsDown ? (
              <ArrowDown
                color={trendColor}
                height={13}
                testID={testID ? `${testID}-trend-arrow-down` : undefined}
                width={13}
              />
            ) : (
              <ArrowUp
                color={trendColor}
                height={13}
                testID={testID ? `${testID}-trend-arrow-up` : undefined}
                width={13}
              />
            )}
            <AppText
              numberOfLines={1}
              style={[styles.trendLabel, { color: trendColor }]}
              variant="label"
            >
              {trendLabel}
            </AppText>
          </View>
        ) : null}

        {showTrend && trendCaption ? (
          <AppText
            color="gray600"
            numberOfLines={1}
            testID={testID ? `${testID}-trend-caption` : undefined}
            variant="caption"
          >
            {trendCaption}
          </AppText>
        ) : null}

        {showQuantity ? (
          <AppText
            color="gray600"
            numberOfLines={1}
            testID={testID ? `${testID}-quantity` : undefined}
            variant="label"
          >
            {`Qty: ${quantity}`}
          </AppText>
        ) : null}
      </View>
    </Container>
  );
}

const styles = StyleSheet.create({
  middle: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  // Price: 14px Bold gray900 / 150% (Figma 992:10059).
  priceText: {
    fontFamily: 'SpotlightBodyBold',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'right',
  },
  right: {
    alignItems: 'flex-end',
    gap: 4,
    justifyContent: 'center',
    marginLeft: 8,
  },
  selectLeading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  slabThumbnail: {
    height: SLAB_THUMBNAIL_HEIGHT,
    position: 'relative',
    width: SLAB_THUMBNAIL_WIDTH,
  },
  thumbnail: {
    height: THUMBNAIL_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
    width: THUMBNAIL_WIDTH,
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  // Delta label: 13px Medium, color set inline (Figma 1263:3148).
  trendLabel: {
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
    lineHeight: 18.2,
  },
  // green/50 | red/50 pill with a 4px radius (Figma 992:10060).
  trendPill: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 3.5,
    paddingLeft: 2,
    paddingRight: 4,
    paddingVertical: 2,
  },
});
