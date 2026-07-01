import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { HeartToggle } from '@/components/heart-toggle';

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
// Pinch-to-zoom ceiling for inspecting foil / text / centering.
const MAX_ZOOM = 4;

export function CardDetailHero({
  imageUrl,
  name,
  isFavorite,
  onToggleFavorite,
  testID,
}: CardDetailHeroProps) {
  const theme = useSpotlightTheme();

  // Focal-point pinch: zoom toward the pinch midpoint and let the user drag that
  // midpoint to move AROUND the magnified card (inspect a corner/edge), not just a
  // center blow-up. Scale + pan both snap back on release — the zoom is a transient
  // inspect gesture. The elevated zIndex lets the zoomed art render above the PDP
  // content mid-gesture. `frameW/H` are the wrapper's measured size so the focal
  // offset can be taken from its center.
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const frameW = useSharedValue(0);
  const frameH = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      'worklet';
      const nextScale = Math.min(Math.max(event.scale, 1), MAX_ZOOM);
      scale.value = nextScale;
      // Keep the focal point pinned under the fingers: scaling about the wrapper
      // center moves a point by (focal − center) × scale, so translate it back by
      // (focal − center) × (1 − scale). As the fingers move, the focal follows —
      // which is what makes the card pan around while zoomed.
      translateX.value = (event.focalX - frameW.value / 2) * (1 - nextScale);
      translateY.value = (event.focalY - frameH.value / 2) * (1 - nextScale);
    })
    .onEnd(() => {
      'worklet';
      scale.value = withTiming(1);
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    zIndex: scale.value > 1 ? 10 : 0,
  }));

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray50 }]} testID={testID}>
      {/* Card centered inside a soft gray panel (Figma 1086:400 "Background" +
          1086:401 "Product Image"): a full-bleed gray/50 band with the card art
          shrunk to ~52% width and a soft drop shadow. Pinch to zoom in place. */}
      <GestureDetector gesture={pinch}>
        <Animated.View
          onLayout={(event) => {
            frameW.value = event.nativeEvent.layout.width;
            frameH.value = event.nativeEvent.layout.height;
          }}
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
    </View>
  );
}

const styles = StyleSheet.create({
  favorite: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    // 36×36 to match the header's share/back IconButtons (size 36) — same right
    // inset (16) + same size keeps the heart on the same vertical axis as share.
    height: 36,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    top: 16,
    width: 36,
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
