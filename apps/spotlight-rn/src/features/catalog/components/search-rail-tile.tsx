import { memo, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

type SearchRailTileProps = {
  result: CatalogSearchResult;
  onPress: (result: CatalogSearchResult) => void;
  testID: string;
};

// Figma 6607:7587: card art 102 wide at the trading-card ratio (102×142).
const CARD_ART_WIDTH = 102;
const CARD_ART_HEIGHT = 142;
// Figma 6597:6003: sealed product shot 103×140; the name line is wider (151).
const SEALED_ART_WIDTH = 103;
const SEALED_ART_HEIGHT = 140;
const SEALED_TEXT_WIDTH = 151;

/** "271/264 · Perfect Order" — the number without its "#", then the set. */
export function railCardSubtitle(result: CatalogSearchResult): string | null {
  const number = result.cardNumber.trim().replace(/^#/, '');
  const set = result.subtitle?.trim() || result.setName?.trim() || '';
  return [number, set].filter(Boolean).join(' · ') || null;
}

/**
 * One tile in a Search landing rail (Figma 6607:7586 card / 6597:6025 sealed):
 * a white rounded box, the art, then name, (card only) number · set, and price,
 * all centred. Unpriced items drop the price line.
 */
export const SearchRailTile = memo(function SearchRailTile({ result, onPress, testID }: SearchRailTileProps) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);
  const isSealed = result.productKind === 'sealed';
  const imageUrl = result.smallImageUrl ?? result.imageUrl ?? null;
  const subtitle = isSealed ? null : railCardSubtitle(result);
  const textWidth = isSealed ? SEALED_TEXT_WIDTH : CARD_ART_WIDTH;

  return (
    <Pressable
      accessibilityLabel={result.name}
      accessibilityRole="button"
      onPress={() => onPress(result)}
      style={({ pressed }) => [
        styles.tile,
        isSealed ? styles.sealedTile : styles.cardTile,
        { backgroundColor: theme.colors.gray0, opacity: pressed ? 0.88 : 1 },
      ]}
      testID={testID}
    >
      <View
        style={[
          isSealed ? styles.sealedArt : styles.cardArt,
          { backgroundColor: isSealed ? theme.colors.gray0 : theme.colors.gray100 },
        ]}
        testID={`${testID}-art`}
      >
        {imageUrl && !hasImageError ? (
          <Image
            accessibilityIgnoresInvertColors
            onError={() => setHasImageError(true)}
            resizeMode={isSealed ? 'contain' : 'cover'}
            source={{ uri: imageUrl }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
      </View>
      <View style={[isSealed ? styles.sealedDetails : styles.cardDetails, { width: textWidth }]}>
        <Text
          numberOfLines={isSealed ? 2 : 1}
          style={[styles.centered, theme.typography.captionMedium, { color: theme.colors.gray900 }]}
        >
          {result.name}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={[styles.centered, theme.typography.overline, { color: theme.colors.gray600 }]}
          >
            {subtitle}
          </Text>
        ) : null}
        {result.marketPrice != null ? (
          <Text
            numberOfLines={1}
            style={[styles.centered, theme.typography.captionStrong, { color: theme.colors.gray900 }]}
            testID={`${testID}-price`}
          >
            {formatCurrency(result.marketPrice, result.currencyCode ?? 'USD')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  cardArt: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    height: CARD_ART_HEIGHT,
    overflow: 'hidden',
    width: CARD_ART_WIDTH,
  },
  cardDetails: {
    alignItems: 'center',
    gap: spacing.xxxs,
  },
  cardTile: {
    gap: 6,
    padding: spacing.sm,
  },
  centered: {
    textAlign: 'center',
    width: '100%',
  },
  sealedArt: {
    height: SEALED_ART_HEIGHT,
    overflow: 'hidden',
    width: SEALED_ART_WIDTH,
  },
  sealedDetails: {
    alignItems: 'center',
    gap: spacing.xxs,
  },
  sealedTile: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  tile: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
  },
});
