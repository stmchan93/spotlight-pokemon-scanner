import { IconChevronLeft } from '@tabler/icons-react-native';
import { type StyleProp, type ViewStyle } from 'react-native';

import {
  IconButton,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  useSpotlightTheme,
} from '@spotlight/design-system';

/**
 * 40pt, matching `glassNavBubbleSizes.compact` and the 40pt `SearchEntryPill`,
 * so every control in a top bar sits level (Figma toolbar 3567:22969).
 *
 * NOTE: the scanner does NOT read this. It used to, and that coupling was a
 * hazard — `raw-scanner-capture-surface` derives the reticle's top edge from its
 * header height, so nudging a button's diameter for styling reasons silently
 * moved the scan window and changed the crop sent to matching. It now carries
 * its own frozen constant.
 */
export const chromeBackButtonSize = 40;

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
        size={glassNavBubbleGlyphSize}
        strokeWidth={glassNavBubbleGlyphStrokeWidth}
      />
    </IconButton>
  );
}
