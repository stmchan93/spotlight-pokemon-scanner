import { ArrowDown, ArrowUp } from 'iconoir-react-native';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type CardListRowProps = {
  imageUrl: string | null;
  name: string;
  cardNumber?: string | null;
  setName?: string | null;
  gradeLabel?: string | null;
  marketPrice: number | null;
  currencyCode?: string;
  trendChangeAmount?: number | null;
  quantity: number;
  /**
   * When true, the row draws a top hairline in addition to its bottom hairline.
   * Pass this only for the first row in a list so rows share single 1px
   * dividers (each row's bottom border) with a top border framing the list,
   * instead of stacking two borders between adjacent rows.
   */
  firstInSection?: boolean;
  onPress?: () => void;
  testID?: string;
};

const THUMBNAIL_WIDTH = 54;
const THUMBNAIL_HEIGHT = 78;
const THUMBNAIL_RADIUS = 2;

const DELTA_UP_BACKGROUND = 'rgba(76, 175, 110, 0.15)';
const DELTA_DOWN_BACKGROUND = 'rgba(224, 82, 76, 0.15)';

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
  marketPrice,
  currencyCode = 'USD',
  trendChangeAmount,
  quantity,
  firstInSection = false,
  onPress,
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
  const hasPrice = marketPrice !== null && Number.isFinite(marketPrice);
  const trend = typeof trendChangeAmount === 'number' && Number.isFinite(trendChangeAmount)
    ? trendChangeAmount
    : 0;
  const showTrend = trend !== 0;
  const trendIsDown = trend < 0;
  const trendColor = trendIsDown ? theme.colors.redDelta : theme.colors.greenDelta;

  const Container = onPress ? Pressable : View;
  const containerProps = onPress
    ? {
        accessibilityRole: 'button' as const,
        onPress,
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

      <View style={styles.middle}>
        <AppText color="textPrimary" numberOfLines={1} variant="bodyStrong">
          {name}
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

      <View style={styles.right}>
        {hasPrice ? (
          <AppText
            color="textPrimary"
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
            style={[
              styles.trendPill,
              {
                backgroundColor: trendIsDown
                  ? DELTA_DOWN_BACKGROUND
                  : DELTA_UP_BACKGROUND,
                borderRadius: theme.radii.pill,
              },
            ]}
            testID={testID ? `${testID}-trend` : undefined}
          >
            {trendIsDown ? (
              <ArrowDown
                color={trendColor}
                height={12}
                testID={testID ? `${testID}-trend-arrow-down` : undefined}
                width={12}
              />
            ) : (
              <ArrowUp
                color={trendColor}
                height={12}
                testID={testID ? `${testID}-trend-arrow-up` : undefined}
                width={12}
              />
            )}
            <AppText
              numberOfLines={1}
              style={[styles.trendLabel, { color: trendColor }]}
              variant="caption"
            >
              {formatCurrency(Math.abs(trend), currencyCode)}
            </AppText>
          </View>
        ) : null}

        <AppText
          color="textMuted"
          numberOfLines={1}
          testID={testID ? `${testID}-quantity` : undefined}
          variant="caption"
        >
          {`Qty: ${quantity}`}
        </AppText>
      </View>
    </Container>
  );
}

const styles = StyleSheet.create({
  middle: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  priceText: {
    textAlign: 'right',
  },
  right: {
    alignItems: 'flex-end',
    gap: 2,
    justifyContent: 'center',
    marginLeft: 8,
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
  trendLabel: {
    // color set inline based on direction
  },
  trendPill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
