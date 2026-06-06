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

// Portrait trading-card aspect (5:7), matching the catalog hero.
const CARD_ASPECT = 5 / 7;
const PANEL_HEIGHT = 320;

export function CardDetailHero({
  imageUrl,
  name,
  isFavorite,
  onToggleFavorite,
  testID,
}: CardDetailHeroProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.xxl,
        },
      ]}
      testID={testID}
    >
      <View style={styles.imageWrap}>
        <CachedImage
          accessibilityLabel={name}
          cachePolicy={imageCachePolicy.hero}
          contentFit="contain"
          style={styles.image}
          uri={imageUrl}
        />
      </View>

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
    height: '100%',
  },
  imageWrap: {
    alignItems: 'center',
    height: PANEL_HEIGHT - 24,
    justifyContent: 'center',
  },
  panel: {
    alignItems: 'center',
    height: PANEL_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingVertical: 12,
    position: 'relative',
    width: '100%',
  },
});

export default CardDetailHero;
