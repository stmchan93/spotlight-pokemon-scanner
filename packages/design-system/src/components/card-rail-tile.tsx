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

// Portrait trading-card art (Scrydex ~245×342). Rail 128 wide ≈ the mockup's
// 128×178; feature art 86×120 (docs/meta-feed-mockup/v2/SimilarV7).
export const CARD_RAIL_TILE_WIDTH = 128;
const CARD_ASPECT = 342 / 245;
const FEATURE_ART_WIDTH = 86;
const ART_RADIUS = 6;

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
  const artWidth = feature ? FEATURE_ART_WIDTH : CARD_RAIL_TILE_WIDTH;

  const art = (
    <View
      style={[
        styles.art,
        { width: artWidth, height: Math.round(artWidth * CARD_ASPECT), backgroundColor: theme.colors.gray200 },
      ]}
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
      <AppText color="gray900" ellipsizeMode="tail" numberOfLines={1} variant={feature ? 'titleSmall' : 'titleXsmall'}>
        {name}
      </AppText>
      {subtitle ? (
        <AppText color="gray600" ellipsizeMode="tail" numberOfLines={1} variant="captionMedium">
          {subtitle}
        </AppText>
      ) : null}
      {priceLabel ? (
        <AppText
          color="gray900"
          style={feature ? styles.featurePrice : null}
          testID={testID ? `${testID}-price` : undefined}
          variant={feature ? 'titleMedium' : 'bodyStrong'}
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
    gap: spacing.xxs,
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
    borderCurve: 'continuous',
    borderRadius: ART_RADIUS,
    overflow: 'hidden',
  },
  railDetails: {
    gap: 2,
  },
  featureDetails: {
    flex: 1,
    gap: 2,
  },
  featurePrice: {
    marginTop: spacing.xxxs,
  },
});
