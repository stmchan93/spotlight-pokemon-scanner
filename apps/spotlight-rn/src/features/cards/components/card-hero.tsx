import type { ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';
import { IconHeart, IconHeartFilled } from '@tabler/icons-react-native';

type CardHeroFavorite = {
  isFavorite: boolean;
  isPending?: boolean;
  onToggle: () => void;
  color: string;
  testID?: string;
};

type CardHeroProps = {
  imageUrl: string | null;
  imageFallbackText?: string;
  name: string;
  metaLines: string[];
  favorite?: CardHeroFavorite | null;
  belowMeta?: ReactNode;
  testID?: string;
};

export function CardHero({
  imageUrl,
  imageFallbackText,
  name,
  metaLines,
  favorite,
  belowMeta,
  testID,
}: CardHeroProps) {
  const theme = useSpotlightTheme();
  const trimmedLines = metaLines.map((line) => line.trim()).filter(Boolean);

  return (
    <View style={styles.block} testID={testID}>
      <View style={styles.imageStage}>
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={styles.image} />
        ) : (
          <View style={styles.imageFallback}>
            <Text style={[theme.typography.titleCompact, styles.imageFallbackText]}>
              {imageFallbackText ?? name}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.titleRow}>
        <Text
          numberOfLines={2}
          style={[theme.typography.title, styles.titleCentered]}
        >
          {name}
        </Text>
        {favorite ? (
          <Pressable
            accessibilityLabel={favorite.isFavorite ? 'Remove from wishlist' : 'Add to wishlist'}
            accessibilityRole="button"
            hitSlop={8}
            onPress={favorite.onToggle}
            style={({ pressed }) => [
              styles.favoriteInline,
              { opacity: favorite.isPending ? 0.6 : pressed ? 0.84 : 1 },
            ]}
            testID={favorite.testID}
          >
            {favorite.isFavorite ? (
              <IconHeartFilled color={favorite.color} size={20} />
            ) : (
              <IconHeart color={favorite.color} size={20} strokeWidth={2} />
            )}
          </Pressable>
        ) : null}
      </View>

      {trimmedLines.map((line, index) => (
        <Text
          key={`${index}-${line}`}
          style={[theme.typography.bodyStrong, styles.metaCentered, { color: theme.colors.textSecondary }]}
        >
          {line}
        </Text>
      ))}

      {belowMeta ? <View style={styles.belowMeta}>{belowMeta}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  belowMeta: {
    alignItems: 'center',
    marginTop: 8,
    width: '100%',
  },
  block: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  favoriteInline: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  image: {
    height: 320,
    resizeMode: 'contain',
    width: 224,
  },
  imageFallback: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    height: 320,
    justifyContent: 'center',
    paddingHorizontal: 16,
    width: 224,
  },
  imageFallbackText: {
    ...textStyles.titleCompact,
    color: 'rgba(15, 15, 18, 0.5)',
    textAlign: 'center',
  },
  imageStage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaCentered: {
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  titleCentered: {
    color: colors.textPrimary,
    flexShrink: 1,
    textAlign: 'center',
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 4,
    paddingHorizontal: 16,
  },
});

export default CardHero;
