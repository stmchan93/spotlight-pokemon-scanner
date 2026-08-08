import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

type SearchEntryPillProps = {
  /** Placeholder-style copy shown centered in the pill, e.g. "Search Cards". */
  label: string;
  onPress?: () => void;
  /** Defaults to `label`. */
  accessibilityLabel?: string;
  /**
   * Optional badge pinned to the left edge (the app mark in the feed top bar).
   * It is absolutely positioned so the label stays centered in the FULL pill
   * rather than in the space left over beside it — the Figma behaviour.
   */
  leading?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Figma 3505:14526 — 36pt tall, matching the 36pt icon buttons beside it. */
const PILL_HEIGHT = 36;
/** Room for the leading badge, mirrored on the right so the label stays centered. */
const LABEL_INSET = 36;

/**
 * A tappable search ENTRY — a pill that looks like a search field but is a
 * button: pressing it opens a real search surface elsewhere. Use it in top bars
 * where search is a destination, not an inline filter (`SearchField` is the
 * primitive for actually typing into).
 */
export function SearchEntryPill({
  label,
  onPress,
  accessibilityLabel,
  leading,
  style,
  testID,
}: SearchEntryPillProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: theme.colors.gray50,
          borderColor: theme.colors.gray200,
          borderRadius: theme.radii.pill,
          borderWidth: theme.borderWidths.rule,
          opacity: pressed ? 0.84 : 1,
        },
        style,
      ]}
      testID={testID}
    >
      <Text
        numberOfLines={1}
        style={[theme.typography.label, styles.label, { color: theme.colors.gray500 }]}
      >
        {label}
      </Text>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    flexShrink: 1,
    marginHorizontal: LABEL_INSET,
    textAlign: 'center',
  },
  leading: {
    bottom: 0,
    justifyContent: 'center',
    left: 4,
    position: 'absolute',
    top: 0,
  },
  pill: {
    alignItems: 'center',
    flexDirection: 'row',
    height: PILL_HEIGHT,
    justifyContent: 'center',
  },
});
