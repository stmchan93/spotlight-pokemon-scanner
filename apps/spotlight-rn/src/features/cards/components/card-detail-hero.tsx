import { Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import { Heart, HeartSolid } from 'iconoir-react-native';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';

type CardDetailHeroProps = {
  imageUrl: string | null;
  name: string;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  testID?: string;
};

// Portrait trading-card aspect (5:7).
const CARD_ASPECT = 5 / 7;

export function CardDetailHero({
  imageUrl,
  name,
  isFavorite,
  onToggleFavorite,
  testID,
}: CardDetailHeroProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.root} testID={testID}>
      {/* Full-bleed card with a soft drop shadow (Figma 992:7544): the card art
          spans the content width instead of sitting inside a gray panel. */}
      <CachedImage
        accessibilityLabel={name}
        cachePolicy={imageCachePolicy.hero}
        contentFit="contain"
        style={[styles.image, { borderRadius: theme.radii.md }]}
        uri={imageUrl}
      />

      <Pressable
        accessibilityLabel={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        accessibilityRole="button"
        accessibilityState={{ selected: isFavorite }}
        hitSlop={8}
        onPress={onToggleFavorite}
        style={({ pressed }) => [
          styles.favorite,
          {
            backgroundColor: theme.colors.canvasElevated,
            borderColor: theme.colors.outlineSubtle,
            opacity: pressed ? 0.82 : 1,
          },
        ]}
        testID={testID ? `${testID}-favorite` : undefined}
      >
        {isFavorite ? (
          <HeartSolid color={theme.colors.brandStrong} height={20} width={20} />
        ) : (
          <Heart color={theme.colors.gray600} height={20} strokeWidth={2} width={20} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  favorite: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    position: 'absolute',
    right: 12,
    top: 12,
    width: 40,
  },
  image: {
    aspectRatio: CARD_ASPECT,
    elevation: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    width: '100%',
  },
  root: {
    alignItems: 'center',
    position: 'relative',
    width: '100%',
  },
});

export default CardDetailHero;
