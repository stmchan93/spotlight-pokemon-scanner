import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Badge, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { HeartToggle } from '@/components/heart-toggle';

type CardDetailHeroProps = {
  imageUrl: string | null;
  name: string;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  /** Public "like" count (wishlist count) shown as social proof. */
  likeCount?: number;
  /** Distinct recent viewers ("people watching") shown as social proof. */
  watcherCount?: number;
  testID?: string;
};

function likesLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'like' : 'likes'}`;
}

function watchingLabel(count: number): string {
  return `${count.toLocaleString()} watching`;
}

// Portrait trading-card aspect (5:7).
const CARD_ASPECT = 5 / 7;
// Card occupies ~52% of the panel width (Figma 1086:401 — 205pt card art in a
// 393pt frame), centered inside the gray backdrop.
const CARD_WIDTH_RATIO = 0.52;
// Pinch-to-zoom ceiling for inspecting foil / text / centering.
const MAX_ZOOM = 4;

export function CardDetailHero({
  imageUrl,
  name,
  isFavorite,
  onToggleFavorite,
  likeCount = 0,
  watcherCount = 0,
  testID,
}: CardDetailHeroProps) {
  const theme = useSpotlightTheme();

  // Pinch-in-place zoom: scale the card from center while pinching, snap back on
  // release. Center-zoom keeps the math layout-free and reliable; the elevated
  // zIndex lets the zoomed art render above following PDP content mid-gesture.
  const scale = useSharedValue(1);
  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      'worklet';
      scale.value = Math.min(Math.max(event.scale, 1), MAX_ZOOM);
    })
    .onEnd(() => {
      'worklet';
      scale.value = withTiming(1);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    zIndex: scale.value > 1 ? 10 : 0,
  }));

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray50 }]} testID={testID}>
      {/* Card centered inside a soft gray panel (Figma 1086:400 "Background" +
          1086:401 "Product Image"): a full-bleed gray/50 band with the card art
          shrunk to ~52% width and a soft drop shadow. Pinch to zoom in place. */}
      <GestureDetector gesture={pinch}>
        <Animated.View
          style={[styles.imageWrapper, { borderRadius: theme.radii.md }, animatedStyle]}
        >
          <CachedImage
            accessibilityLabel={name}
            cachePolicy={imageCachePolicy.hero}
            contentFit="contain"
            style={[styles.image, { borderRadius: theme.radii.md }]}
            uri={imageUrl}
          />
        </Animated.View>
      </GestureDetector>

      <Pressable
        accessibilityLabel={isFavorite ? 'Remove from wishlist' : 'Add to wishlist'}
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
        <HeartToggle
          bounce="lively"
          burst
          filled={isFavorite}
          fill={theme.colors.dangerStrong}
          size={20}
          stroke={theme.colors.gray600}
        />
      </Pressable>

      {(likeCount > 0 || watcherCount > 0) ? (
        <View style={styles.stats} testID={testID ? `${testID}-stats` : undefined}>
          {likeCount > 0 ? (
            <Badge
              label={likesLabel(likeCount)}
              size="sm"
              testID={testID ? `${testID}-like-count` : undefined}
              tone="danger"
            />
          ) : null}
          {watcherCount > 0 ? (
            <Badge
              label={watchingLabel(watcherCount)}
              size="sm"
              testID={testID ? `${testID}-watcher-count` : undefined}
              tone="info"
            />
          ) : null}
        </View>
      ) : null}
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
    height: '100%',
    width: '100%',
  },
  imageWrapper: {
    aspectRatio: CARD_ASPECT,
    // Shadow lives on the wrapper so it scales with the card during a pinch.
    elevation: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    width: `${CARD_WIDTH_RATIO * 100}%`,
  },
  stats: {
    bottom: 16,
    flexDirection: 'row',
    gap: 8,
    left: 16,
    position: 'absolute',
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
