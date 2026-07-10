import { ArrowDown, ArrowUp } from 'iconoir-react-native';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { GraderWordmark, hasGraderWordmark, psaGradeDescriptor } from './grader-wordmark';
import { SelectionCheckCircle } from './selection-check-circle';

export type CardListRowProps = {
  imageUrl: string | null;
  name: string;
  cardNumber?: string | null;
  setName?: string | null;
  gradeLabel?: string | null;
  /**
   * Slab identity for the branded grade line (Collectr-style: the grader's
   * OWN mark + grade, e.g. `[PSA] 10 (GEM-MT)`). When `grader` + `grade` are
   * set they take precedence over `gradeLabel`; the descriptor is PSA-only.
   * Raw cards keep passing their condition text via `gradeLabel`.
   */
  grader?: string | null;
  grade?: string | null;
  /** Trailing text after the branded grade, e.g. the print variant
   * (`[PSA] 10 (GEM-MT) · Holofoil`). Ignored unless the branded line shows. */
  gradeSuffix?: string | null;
  marketPrice: number | null;
  currencyCode?: string;
  trendChangeAmount?: number | null;
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
  gradeSuffix,
  marketPrice,
  currencyCode = 'USD',
  trendChangeAmount,
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
  // Branded slab line: keyed strictly by THIS entry's grader (a CGC card never
  // shows the PSA mark); the "(GEM-MT)" descriptor applies to PSA grades only.
  const graderText = (grader ?? '').trim();
  const slabGradeText = (grade ?? '').trim();
  const showBrandedGrade = graderText.length > 0 && slabGradeText.length > 0;
  const descriptor =
    showBrandedGrade && graderText.toLowerCase() === 'psa'
      ? psaGradeDescriptor(slabGradeText)
      : null;
  const suffixText = (gradeSuffix ?? '').trim();
  const brandedGradeLine = [
    descriptor ? `${slabGradeText} (${descriptor})` : slabGradeText,
    suffixText,
  ]
    .filter(Boolean)
    .join(' · ');
  const gradeText = showBrandedGrade ? '' : (gradeLabel ?? '').trim();
  const hasPrice = marketPrice !== null && Number.isFinite(marketPrice);
  const trend = typeof trendChangeAmount === 'number' && Number.isFinite(trendChangeAmount)
    ? trendChangeAmount
    : 0;
  const showTrend = trend !== 0;
  const trendIsDown = trend < 0;
  const trendColor = trendIsDown ? theme.colors.deltaDownText : theme.colors.deltaUpText;
  const trendBackground = trendIsDown ? theme.colors.deltaDownSurface : theme.colors.deltaUpSurface;

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

      {showThumbnail ? (
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
        {showBrandedGrade ? (
          <View style={styles.gradeLine} testID={testID ? `${testID}-grader-line` : undefined}>
            <GraderWordmark
              grader={graderText}
              size="md"
              testID={testID ? `${testID}-grader-mark` : undefined}
            />
            <AppText color="gray600" numberOfLines={1} variant="label">
              {brandedGradeLine}
            </AppText>
          </View>
        ) : gradeText ? (
          <AppText color="gray600" numberOfLines={1} variant="label">
            {gradeText}
          </AppText>
        ) : null}
      </View>

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
              {formatCurrency(Math.abs(trend), currencyCode)}
            </AppText>
          </View>
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
  // Branded slab line: [grader mark] grade text, baseline-ish centered.
  gradeLine: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
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
