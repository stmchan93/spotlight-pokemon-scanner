import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

export type PillButtonTone = 'default' | 'filter';

type PillButtonProps = {
  label: string;
  /**
   * Optional icon rendered before the label (Figma Insights chips: the Likes
   * heart, the Price sort arrows). The caller owns the icon color so it can
   * follow the selected state.
   */
  leading?: ReactNode;
  minWidth?: number;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Visual tone. 'default' is the brand-yellow pill used in chart range pills,
   * filter modal etc. 'filter' is the chip used in the Collection / Sales chip
   * rows: a white pill when inactive and a solid black (gray900) pill with a
   * white label when selected (Figma — selected chips read black, not purple).
   */
  tone?: PillButtonTone;
};

export function PillButton({
  label,
  leading,
  minWidth,
  onPress,
  selected = false,
  style,
  testID,
  tone = 'default',
}: PillButtonProps) {
  const theme = useSpotlightTheme();

  const containerStyle = tone === 'filter' ? styles.filterContainer : styles.container;
  const labelStyle = tone === 'filter' ? theme.typography.label : theme.typography.control;

  const backgroundColor = tone === 'filter'
    ? (selected ? theme.colors.gray900 : theme.colors.gray0)
    : (selected ? theme.colors.brand : theme.colors.field);

  const borderColor = tone === 'filter'
    ? (selected ? theme.colors.gray900 : theme.colors.gray300)
    : (selected ? theme.colors.brand : theme.colors.outlineSubtle);

  const labelColor = tone === 'filter'
    ? (selected ? theme.colors.gray0 : theme.colors.gray900)
    : theme.colors.textPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        containerStyle,
        {
          minWidth,
          backgroundColor,
          borderColor,
          opacity: pressed ? 0.88 : 1,
        },
        style,
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Text
        style={[
          labelStyle,
          styles.label,
          {
            color: labelColor,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  filterContainer: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  label: {
    textAlign: 'center',
  },
  leading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
