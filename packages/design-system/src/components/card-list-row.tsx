import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { borderWidths } from '../tokens';
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
  /**
   * Signed percent rendered directly under the price, Robinhood-style
   * (`+2.26%` green / `-2.26%` red). Callers pass the since-added change
   * percent. Exactly 0 renders as gray `0.00%` ("tracked but flat" — e.g. a
   * card added since the last price sync); null/non-finite hides the line.
   * Penny guard: when `marketPrice` is < $1 the line is suppressed entirely —
   * a −50% on a $0.04 card is technically true but misleads (pennies aren't
   * investment content).
   */
  trendChangePercent?: number | null;
  /**
   * Market-price series (oldest → newest) for a 62×22 sparkline between the
   * name/set copy and the price column: [thumb][name/set][sparkline][price].
   * Absent/empty → no sparkline, layout identical to before.
   */
  sparkPoints?: number[];
  /**
   * Percent change across `sparkPoints`; tints the sparkline green (>= 0) or
   * red (< 0). The sparkline tint is independent of the percent line under the
   * price — that carries the since-added truth, the sparkline its own 30d
   * direction.
   */
  sparkTrendPct?: number | null;
  quantity: number;
  /**
   * When false, the "Qty: N" line (bottom of the left copy stack, under the
   * variant/condition line) is hidden — e.g. wishlist rows, which have no
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

// Always two decimals ("$1,100.00") — the Figma frames' bare "$1,100" examples
// are mock content, not a formatting spec (confirmed with the designer
// 2026-08-18 after briefly shipping a ".00"-trimming version).
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
  trendChangePercent,
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

  // Figma rows (Wishlist 4173:82045, Collection 4134:50940) rule with a 0.5pt
  // gray-300 hairline, not the old 1pt gray-100.
  const borderStyle = {
    borderBottomColor: theme.colors.gray300,
    ...(firstInSection
      ? { borderTopColor: theme.colors.gray300, borderTopWidth: borderWidths.rule }
      : null),
  };

  const metaLine = buildMetaLine(cardNumber, setName);
  const gradeText = (gradeLabel ?? '').trim();
  // Slab-case frame on the thumbnail — keyed by THIS entry's grader.
  const graderText = (grader ?? '').trim();
  const showSlabFrame = showThumbnail && graderText.length > 0;
  const hasPrice = marketPrice !== null && Number.isFinite(marketPrice);
  // Signed percent under the price (Robinhood-style): "+2.26%" green /
  // "-2.26%" red, two decimals; the sign carries the direction (no arrow).
  // Exactly 0 renders as a quiet gray "0.00%" — "tracked but flat" (e.g. a
  // card added since the last price sync) must read differently from "no
  // data" (null → hidden entirely).
  const trendPercent = typeof trendChangePercent === 'number' && Number.isFinite(trendChangePercent)
    ? trendChangePercent
    : null;
  // Penny guard: sub-$1 cards render no percent at all — a −50% on $0.04 is
  // technically true but misleads (pennies aren't investment content).
  const isPennyPrice = marketPrice !== null && marketPrice < 1;
  const showTrend = trendPercent !== null && !isPennyPrice;
  const trendColor =
    trendPercent !== null && trendPercent !== 0
      ? trendPercent < 0
        ? theme.colors.red400
        : theme.colors.green400
      : theme.colors.gray600;
  const trendLabel = trendPercent !== null
    ? `${trendPercent > 0 ? '+' : ''}${trendPercent.toFixed(2)}%`
    : '';
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

      {/*
        Two groups, SPACE_BETWEEN — name/set anchored to the row top, the
        grade/qty line to the bottom of the 80pt thumb, matching Figma's Card
        Details (Wishlist 4173:82045, Collection 4134:50940).
      */}
      <View style={styles.middle}>
        <View style={styles.copyGroup}>
          <AppText color="gray900" numberOfLines={1} variant="titleSmall">
            {name}
          </AppText>
          {metaLine ? (
            <AppText color="gray600" numberOfLines={1} variant="label">
              {metaLine}
            </AppText>
          ) : null}
        </View>
        {gradeText || showQuantity ? (
          <View style={styles.copyGroup}>
            {gradeText ? (
              <AppText color="gray600" numberOfLines={1} variant="label">
                {gradeText}
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
          <AppText
            numberOfLines={1}
            style={[styles.trendLabel, { color: trendColor }]}
            testID={testID ? `${testID}-trend` : undefined}
            variant="label"
          >
            {trendLabel}
          </AppText>
        ) : null}
      </View>
    </Container>
  );
}

const styles = StyleSheet.create({
  copyGroup: {
    gap: 4,
  },
  // Stretch so the copy stack starts at the row top like Figma's Card Details
  // (SPACE_BETWEEN over the 80pt thumb) instead of centering.
  middle: {
    alignSelf: 'stretch',
    flex: 1,
    justifyContent: 'space-between',
    minWidth: 0,
  },
  // Price: 14px BOLD gray900 / 150%. The current Figma frames (4173:82045,
  // 4134:50940) spec Regular-400 here, but the user overruled that on
  // 2026-08-18 — bold is the intended weight (matches the older Figma
  // 992:10059). Update the frames, not this, if the design ever changes.
  priceText: {
    fontFamily: 'SpotlightBodyBold',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'right',
  },
  // Price column matches the Figma rows (Wishlist 4173:82045, Collection
  // 4134:50940): stretch the row and SPACE_BETWEEN so the price top-aligns
  // with the title and the trend line sits at the bottom, not centered.
  right: {
    alignItems: 'flex-end',
    alignSelf: 'stretch',
    justifyContent: 'space-between',
    marginLeft: 8,
  },
  selectLeading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.rule,
    flexDirection: 'row',
    // Thumb ↔ copy gap is 8 in Figma (Card Content itemSpacing, 4173:82045).
    gap: 8,
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
  // Signed since-added percent under the price: 14 SemiBold, green400/red400
  // inline (Robinhood-style stacked value + return).
  trendLabel: {
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'right',
  },
});
