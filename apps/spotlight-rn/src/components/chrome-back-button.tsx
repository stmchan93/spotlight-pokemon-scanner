import { IconChevronLeft } from '@tabler/icons-react-native';
import { type StyleProp, type ViewStyle } from 'react-native';

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
      <IconChevronLeft
        color={theme.colors.textPrimary}
        size={18}
        strokeWidth={2.35}
      />
    </IconButton>
  );
}
