import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { radii, spacing } from '../tokens';
import { AppText } from './app-text';

export type CardRailTileLayout = 'rail' | 'feature';

export type CardRailTileProps = {
  imageUrl: string | null;
  name: string;
  /** One line under the name, e.g. "Japanese · Clash of the Blue Sky". */
  subtitle?: string | null;
  /** Preformatted price, e.g. "$1,150"; omitted/null hides the line. */
  priceLabel?: string | null;
  /**
   * 'rail' (default): portrait art over name / subtitle / price, fixed width,
   * for horizontal rails. 'feature': one full-width purple-50 row with the art
   * on the left, for a single highlighted card ("Goes with").
   */
  layout?: CardRailTileLayout;
  /** 'feature' only: a brand-colored call-to-action line under the price. */
  accentLabel?: string | null;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
};

// Portrait trading-card art (Scrydex ~245×342). Both layouts draw it 86×120.
// The rail tile is wider than its art so text gets the extra room (Figma 6322:9014).
export const CARD_RAIL_TILE_WIDTH = 96;
const CARD_ASPECT = 342 / 245;
const ART_WIDTH = 86;
const ART_RADIUS = 3;

export function CardRailTile({
  imageUrl,
  name,
  subtitle,
  priceLabel,
  layout = 'rail',
  accentLabel,
  onPress,
  accessibilityLabel,
  testID,
}: CardRailTileProps) {
  const theme = useSpotlightTheme();
  const feature = layout === 'feature';

  const art = (
    <View
      style={[styles.art, { backgroundColor: theme.colors.gray200 }]}
      testID={testID ? `${testID}-art` : undefined}
    >
      {imageUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          testID={testID ? `${testID}-image` : undefined}
        />
      ) : null}
    </View>
  );

  const details = (
    <View style={feature ? styles.featureDetails : styles.railDetails}>
      <AppText color="gray900" ellipsizeMode="tail" numberOfLines={1} variant={feature ? 'titleSmall' : 'labelStrong'}>
        {name}
      </AppText>
      {subtitle ? (
        <AppText color="gray600" ellipsizeMode="tail" numberOfLines={1} variant={feature ? 'captionMedium' : 'overline'}>
          {subtitle}
        </AppText>
      ) : null}
      {priceLabel ? (
        <AppText
          color="gray900"
          ellipsizeMode="tail"
          numberOfLines={1}
          style={feature ? styles.featurePrice : null}
          testID={testID ? `${testID}-price` : undefined}
          variant={feature ? 'titleMedium' : 'captionStrong'}
        >
          {priceLabel}
        </AppText>
      ) : null}
      {feature && accentLabel ? (
        <AppText color="brandStrong" style={styles.featurePrice} variant="captionStrong">
          {accentLabel}
        </AppText>
      ) : null}
    </View>
  );

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? name}
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        feature ? styles.feature : styles.rail,
        feature ? { backgroundColor: theme.colors.purple50 } : null,
        { opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      {art}
      {details}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: CARD_RAIL_TILE_WIDTH,
    gap: 6,
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.xs,
    borderCurve: 'continuous',
    borderRadius: radii.lg,
  },
  art: {
    width: ART_WIDTH,
    height: Math.round(ART_WIDTH * CARD_ASPECT),
    borderCurve: 'continuous',
    borderRadius: ART_RADIUS,
    overflow: 'hidden',
  },
  railDetails: {
    gap: spacing.xxxs,
  },
  featureDetails: {
    flex: 1,
    gap: 2,
  },
  featurePrice: {
    marginTop: spacing.xxxs,
  },
});
