import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type PillButtonTone = 'default' | 'filter';

type PillButtonProps = {
  label: string;
  minWidth?: number;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Visual tone. 'default' is the brand-yellow pill used in chart range pills,
   * filter modal etc. 'filter' is the chip used in the Collection / Sales chip
   * rows: white fill in both states, with the active chip marked by a strong
   * purple (#7000FF) border instead of the inactive gray border.
   */
  tone?: PillButtonTone;
};

export function PillButton({
  label,
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
    ? theme.colors.gray0
    : (selected ? theme.colors.brand : theme.colors.field);

  const borderColor = tone === 'filter'
    ? (selected ? theme.colors.brandStrong : theme.colors.gray300)
    : (selected ? theme.colors.brand : theme.colors.outlineSubtle);

  const labelColor = tone === 'filter' ? theme.colors.gray900 : theme.colors.textPrimary;

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
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  filterContainer: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  label: {
    textAlign: 'center',
  },
});
