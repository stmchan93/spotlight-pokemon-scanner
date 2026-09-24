import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type MetaCalloutCardProps = {
  /** "Your vintage is up +$312 this week". */
  title: string;
  /**
   * Substring of `title` drawn in the delta color, e.g. "+$312". Ignored when
   * it does not occur in the title.
   */
  highlight?: string | null;
  /** Color of `highlight`: `up` green, `down` red. */
  highlightTone?: 'up' | 'down';
  /** One line under the title, e.g. "4 PSA 10s and 11 raw cards in rising groups". */
  body?: string | null;
  /** Up to two card images, fanned on the left. Empty = no art. */
  imageUrls?: string[];
  onPress?: () => void;
  testID?: string;
};

const THUMB = { height: 50, width: 36 } as const;

/**
 * The viewer's personal line in the Meta pulse (meta feed v2 mockups): a
 * `purple50` card with two fanned card thumbnails, a bold title whose $ figure
 * is tinted, and a caption.
 */
export function MetaCalloutCard({
  title,
  highlight = null,
  highlightTone = 'up',
  body = null,
  imageUrls = [],
  onPress,
  testID,
}: MetaCalloutCardProps) {
  const theme = useSpotlightTheme();
  const images = imageUrls.slice(0, 2);
  const split = highlight ? title.indexOf(highlight) : -1;

  return (
    <Pressable
      accessibilityLabel={[title, body].filter(Boolean).join('. ')}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.colors.purple50,
          borderCurve: 'continuous',
          borderRadius: theme.radii.lg,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
      testID={testID}
    >
      {images.length > 0 ? (
        <View style={styles.fan} testID={testID ? `${testID}-art` : undefined}>
          {images.map((uri, index) => (
            <View
              key={`${uri}:${index}`}
              style={[
                styles.thumb,
                index === 0 ? styles.back : styles.front,
                index === 1 ? theme.shadows.card : null,
                { backgroundColor: theme.colors.gray200, borderCurve: 'continuous' },
              ]}
            >
              <Image
                accessibilityIgnoresInvertColors
                resizeMode="cover"
                source={{ uri }}
                style={[StyleSheet.absoluteFill, styles.thumbImage]}
              />
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.copy}>
        <AppText color="gray900" testID={testID ? `${testID}-title` : undefined} variant="feedRowTitle">
          {split >= 0 && highlight ? (
            <>
              {title.slice(0, split)}
              <AppText color={highlightTone === 'up' ? 'deltaUpText' : 'deltaDownText'} variant="feedRowTitle">
                {highlight}
              </AppText>
              {title.slice(split + highlight.length)}
            </>
          ) : (
            title
          )}
        </AppText>
        {body ? (
          <AppText color="gray600" style={styles.body} variant="captionMedium">
            {body}
          </AppText>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  fan: {
    flexShrink: 0,
    height: 56,
    width: 62,
  },
  thumb: {
    borderRadius: 3,
    height: THUMB.height,
    position: 'absolute',
    width: THUMB.width,
  },
  thumbImage: {
    borderRadius: 3,
  },
  back: {
    left: 0,
    top: 4,
    transform: [{ rotate: '-8deg' }],
  },
  front: {
    left: 24,
    top: 0,
    transform: [{ rotate: '6deg' }],
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  body: {
    marginTop: 2,
  },
});
