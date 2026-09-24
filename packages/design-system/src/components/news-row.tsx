import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type NewsRowProps = {
  /** Preformatted "Source · age", e.g. "PokéBeach · 2h". */
  sourceLabel: string;
  /** Headline as published; never article body text. */
  title: string;
  /** Outlined chips under the headline (game, topic tags). Empty = no row. */
  tags?: string[];
  /** 72×72 thumbnail; null draws the gray200 placeholder square. */
  imageUrl: string | null;
  /** Draw the 0.5pt gray300 rule under the row (every row but the last). */
  divider?: boolean;
  onPress?: () => void;
  testID?: string;
};

/**
 * One headline in the Card news block and the News page (meta feed mockups):
 * source + age, the headline, tag chips, and a square thumbnail on the right.
 * The host decides what a press does (link-out).
 */
export function NewsRow({
  sourceLabel,
  title,
  tags = [],
  imageUrl,
  divider = false,
  onPress,
  testID,
}: NewsRowProps) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityLabel={`${title}, ${sourceLabel}`}
      accessibilityRole={onPress ? 'link' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        divider
          ? { borderBottomColor: theme.colors.gray300, borderBottomWidth: theme.borderWidths.rule }
          : null,
        { opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <View style={styles.text}>
        <AppText color="gray700" numberOfLines={1} variant="cardMetaStrong">
          {sourceLabel}
        </AppText>
        <AppText color="gray900" numberOfLines={3} variant="bodyMedium">
          {title}
        </AppText>
        {tags.length > 0 ? (
          <View style={styles.tags}>
            {tags.map((tag) => (
              <View
                key={tag}
                style={[
                  styles.chip,
                  {
                    borderColor: theme.colors.gray300,
                    borderCurve: 'continuous',
                    borderRadius: theme.radii.pill,
                    borderWidth: theme.borderWidths.containerRule,
                  },
                ]}
              >
                <AppText color="gray700" numberOfLines={1} variant="chipLabel">
                  {tag}
                </AppText>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <View
        style={[
          styles.thumb,
          {
            backgroundColor: theme.colors.gray200,
            borderCurve: 'continuous',
            borderRadius: theme.radii.sm,
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
      </View>
    </Pressable>
  );
}

const THUMB_SIZE = 72;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  text: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    alignItems: 'center',
    height: 22,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  thumb: {
    height: THUMB_SIZE,
    overflow: 'hidden',
    width: THUMB_SIZE,
  },
});
