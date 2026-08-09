import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

type ScreenHeaderProps = {
  /** testID for the accessory row. `stacked` only — inline has no such row. */
  accessoryTestID?: string;
  eyebrow?: string;
  /**
   * `inline` (default) sets the accessories and the title side by side on one
   * row. `stacked` gives the accessories a row of their own ABOVE a full-width
   * title, which is the shape Search Cards uses: a back button alone at the top
   * left, the display title beneath it.
   *
   * Stacked is the better choice wherever the title can be long — inline splits
   * the row three ways, so a long title wraps early against the accessories.
   */
  layout?: 'inline' | 'stacked';
  leftAccessory?: ReactNode;
  rightAccessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  testID?: string;
  title: string;
};

export function ScreenHeader({
  accessoryTestID,
  eyebrow,
  layout = 'inline',
  leftAccessory,
  rightAccessory,
  style,
  subtitle,
  testID,
  title,
}: ScreenHeaderProps) {
  const theme = useSpotlightTheme();

  const copy = (
    <View style={layout === 'stacked' ? styles.stackedCopy : styles.copy}>
      {eyebrow ? (
        <Text style={[theme.typography.micro, styles.eyebrow]}>{eyebrow}</Text>
      ) : null}
      <Text style={theme.typography.display}>{title}</Text>
      {subtitle ? (
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  if (layout === 'stacked') {
    return (
      <View style={[styles.stackedHeader, style]} testID={testID}>
        {leftAccessory || rightAccessory ? (
          // `flex-start`, so the row hugs the back button instead of stretching
          // a full-width strip across the top of the screen.
          <View style={styles.stackedAccessoryRow} testID={accessoryTestID}>
            {leftAccessory}
            {rightAccessory}
          </View>
        ) : null}
        {copy}
      </View>
    );
  }

  return (
    <View style={[styles.header, style]} testID={testID}>
      <View style={styles.topRow}>
        <View style={styles.accessorySlot}>
          {leftAccessory}
        </View>
        {copy}
        <View style={[styles.accessorySlot, styles.accessorySlotRight]}>
          {rightAccessory}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  accessorySlot: {
    minWidth: 40,
  },
  accessorySlotRight: {
    alignItems: 'flex-end',
  },
  copy: {
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  eyebrow: {
    letterSpacing: 1.4,
  },
  header: {
    gap: 12,
  },
  stackedAccessoryRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  stackedCopy: {
    gap: 8,
    minWidth: 0,
  },
  stackedHeader: {
    alignItems: 'flex-start',
    // Wider than the inline gap: the title is carrying the row below it rather
    // than sitting beside the accessories.
    gap: 18,
  },
  topRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
});
