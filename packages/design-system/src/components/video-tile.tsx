import { Image, Pressable, StyleSheet, View } from 'react-native';
import { PlaySolid } from 'iconoir-react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type VideoTileProps = {
  title: string;
  /** Preformatted "Channel · 212K views · 3d". */
  metaLabel: string;
  /** Preformatted runtime, e.g. "18:42". Omitted = no badge. */
  durationLabel?: string | null;
  /** 16:9-ish thumbnail; null draws the gray800 placeholder. */
  imageUrl: string | null;
  /** Tile width; the thumbnail keeps the 232×130 ratio. Default 232. Ignored by `row`. */
  width?: number;
  /** `tile` stacks thumbnail over text (rails); `row` puts a 128×72 thumbnail beside it (lists). */
  layout?: 'tile' | 'row';
  onPress?: () => void;
  testID?: string;
};

export const VIDEO_TILE_WIDTH = 232;
const THUMB_RATIO = 130 / 232;

/**
 * A video in a horizontal rail (Set spotlight "Watch", Set page, News page):
 * thumbnail with a play button and duration badge, then title and channel
 * meta. The host decides what a press does (link-out).
 */
export function VideoTile({
  title,
  metaLabel,
  durationLabel,
  imageUrl,
  width = VIDEO_TILE_WIDTH,
  layout = 'tile',
  onPress,
  testID,
}: VideoTileProps) {
  const theme = useSpotlightTheme();
  const isRow = layout === 'row';
  const thumbWidth = isRow ? ROW_THUMB_WIDTH : width;
  return (
    <Pressable
      accessibilityLabel={`${title}, ${metaLabel}`}
      accessibilityRole={onPress ? 'link' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [isRow ? styles.row : { width }, { opacity: pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      <View
        style={[
          styles.thumb,
          {
            backgroundColor: theme.colors.gray800,
            borderCurve: 'continuous',
            borderRadius: theme.radii.sm,
            height: Math.round(thumbWidth * THUMB_RATIO),
            width: thumbWidth,
          },
        ]}
        testID={testID ? `${testID}-thumb` : undefined}
      >
        {imageUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: imageUrl }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View
          style={[
            isRow ? styles.playSmall : styles.play,
            {
              backgroundColor: theme.colors.mediaPlayButton,
              borderCurve: 'continuous',
              borderRadius: theme.radii.pill,
            },
          ]}
        >
          <PlaySolid color={theme.colors.gray900} height={isRow ? 12 : 16} width={isRow ? 12 : 16} />
        </View>
        {durationLabel ? (
          <View
            style={[
              styles.duration,
              {
                backgroundColor: theme.colors.mediaScrim,
                borderCurve: 'continuous',
                borderRadius: DURATION_RADIUS,
              },
            ]}
            testID={testID ? `${testID}-duration` : undefined}
          >
            <AppText color="gray0" variant="tag">
              {durationLabel}
            </AppText>
          </View>
        ) : null}
      </View>
      <View style={isRow ? styles.rowText : null}>
        <AppText color="gray900" numberOfLines={2} style={isRow ? null : styles.title} variant="bodyMedium">
          {title}
        </AppText>
        <AppText color="gray700" numberOfLines={1} variant="cardMeta">
          {metaLabel}
        </AppText>
      </View>
    </Pressable>
  );
}

const DURATION_RADIUS = 3;
const ROW_THUMB_WIDTH = 128;

const styles = StyleSheet.create({
  thumb: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  rowText: {
    flex: 1,
    gap: 4,
  },
  playSmall: {
    alignItems: 'center',
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  play: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  duration: {
    bottom: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    position: 'absolute',
    right: 6,
  },
  title: {
    marginTop: 6,
  },
});
