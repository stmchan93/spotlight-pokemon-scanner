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
// Card occupies ~52% of the panel width (Figma 1086:401 — 205pt card art in a
// 393pt frame), centered inside the gray backdrop.
const CARD_WIDTH_RATIO = 0.52;

export function CardDetailHero({
  imageUrl,
  name,
  isFavorite,
  onToggleFavorite,
  testID,
}: CardDetailHeroProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray50 }]} testID={testID}>
      {/* Card centered inside a soft gray panel (Figma 1086:400 "Background" +
          1086:401 "Product Image"): a full-bleed gray/50 band with the card art
          shrunk to ~52% width and a soft drop shadow. */}
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
    right: 16,
    top: 16,
    width: 40,
  },
  image: {
    aspectRatio: CARD_ASPECT,
    elevation: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    width: `${CARD_WIDTH_RATIO * 100}%`,
  },
  root: {
    alignItems: 'center',
    // Break out of the screen's 16px content padding so the gray band spans
    // edge-to-edge like the Figma frame, then inset the card with 24px of
    // vertical breathing room (Figma 1086 — card at y=24 in a 334pt band).
    marginHorizontal: -16,
    paddingVertical: 24,
    position: 'relative',
  },
});

export default CardDetailHero;
