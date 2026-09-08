import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { PriceSparkline } from './price-sparkline';

export type TopMoverTileProps = {
  imageUrl: string | null;
  name: string;
  /** Second line under the name, e.g. "Surging Sparks · 238/191". */
  subtitle: string;
  /** Preformatted signed percent, e.g. "+218%". */
  changeLabel: string;
  /** Tint: `>= 0` green, `< 0` red, null gray. Also drives the sparkline. */
  changePercent: number | null;
  /** Current price, preformatted, e.g. "$41.16". */
  priceLabel: string;
  /** Prior price, preformatted, e.g. "from $12.95". */
  fromLabel: string;
  /** Market-price series, oldest → newest. */
  sparkPoints: number[];
  onPress?: () => void;
  testID?: string;
};

// Figma 4969:4105 "Card container": 354×142 tile, 90×126 art, 232-wide details.
export const TOP_MOVER_TILE_WIDTH = 354;
export const TOP_MOVER_TILE_HEIGHT = 142;
const ART_WIDTH = 90;
const ART_HEIGHT = 126;
const ART_RADIUS = 6;
const DETAILS_WIDTH = 232;
const SPARKLINE_WIDTH = 62;
const SPARKLINE_HEIGHT = 22;

export function TopMoverTile({
  imageUrl,
  name,
  subtitle,
  changeLabel,
  changePercent,
  priceLabel,
  fromLabel,
  sparkPoints,
  onPress,
  testID,
}: TopMoverTileProps) {
  const theme = useSpotlightTheme();
  const changeColor =
    changePercent == null
      ? theme.colors.gray600
      : changePercent >= 0
        ? theme.colors.green500
        : theme.colors.red500;

  return (
    <Pressable
      accessibilityLabel={`${name}, ${changeLabel}`}
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        {
          backgroundColor: theme.colors.gray50,
          borderCurve: 'continuous',
          borderRadius: theme.radii.sm,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
      testID={testID}
    >
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

      <View style={styles.details}>
        <View style={styles.identity}>
          <AppText color="gray900" ellipsizeMode="tail" numberOfLines={1} variant="titleSmall">
            {name}
          </AppText>
          <AppText color="gray600" ellipsizeMode="tail" numberOfLines={1} variant="bodyMedium">
            {subtitle}
          </AppText>
        </View>

        <View style={styles.changeRow}>
          <AppText
            style={{ color: changeColor }}
            testID={testID ? `${testID}-change` : undefined}
            variant="titleSmall"
          >
            {changeLabel}
          </AppText>
          <PriceSparkline
            backgroundColor={theme.colors.gray50}
            height={SPARKLINE_HEIGHT}
            points={sparkPoints}
            testID={testID ? `${testID}-sparkline` : undefined}
            trendPct={changePercent}
            width={SPARKLINE_WIDTH}
          />
        </View>

        <View style={styles.priceRow}>
          <AppText color="gray900" variant="bodyStrong">
            {priceLabel}
          </AppText>
          <AppText color="gray600" variant="bodyMedium">
            {fromLabel}
          </AppText>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: TOP_MOVER_TILE_WIDTH,
    height: TOP_MOVER_TILE_HEIGHT,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  art: {
    width: ART_WIDTH,
    height: ART_HEIGHT,
    borderCurve: 'continuous',
    borderRadius: ART_RADIUS,
    overflow: 'hidden',
  },
  details: {
    width: DETAILS_WIDTH,
    height: ART_HEIGHT,
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingRight: 16,
  },
  identity: {
    gap: 2,
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
