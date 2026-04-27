import { Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { IconButton, useSpotlightTheme } from '@spotlight/design-system';

export const chromeBackButtonSize = 34;

type ChromeBackButtonProps = {
  accessibilityLabel?: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function ChromeBackButton({
  accessibilityLabel = 'Back',
  onPress,
  style,
  testID,
}: ChromeBackButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <IconButton
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={style}
      size={chromeBackButtonSize}
      testID={testID}
      variant="elevated"
    >
      <Text style={[theme.typography.title, styles.glyph]}>‹</Text>
    </IconButton>
  );
}

const styles = StyleSheet.create({
  glyph: {
    color: '#0F0F12',
    lineHeight: 26,
  },
});
