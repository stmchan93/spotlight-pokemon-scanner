import { BlurView } from 'expo-blur';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@spotlight/design-system';

import { CachedImage, type CachedImageCachePolicy } from '@/components/cached-image';
import { SelfieImage } from './selfie-image';

type SelfieFillProps = {
  /** Local uri of the captured selfie. */
  uri: string;
  cachePolicy?: CachedImageCachePolicy;
  /** expo-blur intensity for the backdrop copy. Lower on small thumbs. */
  blurIntensity?: number;
  /** Applied to the clipping container (size, radius, position). */
  style?: StyleProp<ViewStyle>;
  /** Goes on the `contain` layer — the actual photo, and what tests assert on. */
  testID?: string;
};

/**
 * A selfie that FILLS its box without cropping the subject and without dead
 * black at the edges.
 *
 * WHY THIS EXISTS: the boxes this feature shows the selfie in are square (the
 * result morph card, the 64pt before/after thumb) and the capture is not, so
 * the two obvious options are both wrong:
 *
 *   - `cover` crops ~44% of a 9:16 capture's HEIGHT. On the full-body shot the
 *     capture screen explicitly asks for, that removes your head and your legs.
 *   - `contain` alone keeps the whole photo but pillarboxes it against the dark
 *     stage, which reads on device as "black space between the sides".
 *
 * So: a `cover`-scaled, blurred copy of the SAME selfie fills the box as a
 * backdrop, and the `contain` copy is composited on top. Nothing is cropped
 * away, nothing is dead black, and the bars become an out-of-focus continuation
 * of your own photo — the treatment music/video players use for exactly this.
 *
 * The alternative — giving the box the capture's aspect ratio — was rejected
 * because the box is not ours alone: the morph card shares its square with the
 * artwork cells and both silhouette layers, which are `contain`-fitted into it.
 * Re-shaping the box per capture would move the artwork too, and the whole
 * point of that card is that you and the Pokémon occupy the SAME space.
 *
 * The backdrop is drawn with `CachedImage`, not `SelfieImage`: it is wallpaper,
 * not a photo you are meant to read, so the display mirror does not apply and
 * mirroring it would only cost a second texture upload.
 */
export function SelfieFill({
  uri,
  cachePolicy = 'memory-disk',
  blurIntensity = 44,
  style,
  testID,
}: SelfieFillProps) {
  return (
    <View style={[styles.root, style]}>
      <CachedImage
        cachePolicy={cachePolicy}
        contentFit="cover"
        style={StyleSheet.absoluteFillObject}
        testID={testID ? `${testID}-backdrop` : undefined}
        uri={uri}
      />
      <BlurView intensity={blurIntensity} style={StyleSheet.absoluteFillObject} tint="dark" />
      {/* Knocks the backdrop back far enough that the in-focus copy on top of it
          is unambiguously the subject. */}
      <View pointerEvents="none" style={styles.dim} />
      <SelfieImage
        cachePolicy={cachePolicy}
        contentFit="contain"
        style={StyleSheet.absoluteFillObject}
        testID={testID}
        uri={uri}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scannerCanvas,
    opacity: 0.4,
  },
});
