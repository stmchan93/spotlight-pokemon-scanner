import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

type PillButtonProps = {
  label: string;
  minWidth?: number;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function PillButton({
  label,
  minWidth,
  onPress,
  selected = false,
  style,
  testID,
}: PillButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.container,
        {
          minWidth,
          backgroundColor: selected ? theme.colors.brand : theme.colors.field,
          borderColor: selected ? theme.colors.brand : theme.colors.outlineSubtle,
          opacity: pressed ? 0.88 : 1,
        },
        style,
      ]}
    >
      <Text
        style={[
          theme.typography.control,
          styles.label,
          {
            color: theme.colors.textPrimary,
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
  label: {
    textAlign: 'center',
  },
});
