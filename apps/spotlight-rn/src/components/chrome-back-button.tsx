import { IconChevronLeft, IconX } from '@tabler/icons-react-native';
import { type StyleProp, type ViewStyle } from 'react-native';

import {
  GlassNavBubble,
  type GlassNavBubbleSurface,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  glassNavBubbleSizes,
  useSpotlightTheme,
} from '@spotlight/design-system';

/**
 * 44pt Liquid Glass circle, the iOS toolbar button (Figma 6711:5075), the same
 * `GlassNavBubble` medium every other top-bar control uses.
 *
 * NOTE: the scanner does NOT read this. It used to, and that coupling was a
 * hazard — `raw-scanner-capture-surface` derives the reticle's top edge from its
 * header height, so nudging a button's diameter for styling reasons silently
 * moved the scan window and changed the crop sent to matching. It now carries
 * its own frozen constant.
 */
export const chromeBackButtonSize = glassNavBubbleSizes.medium;

type ChromeBackButtonProps = {
  accessibilityLabel?: string;
  /** `back` = chevron (pushed screens), `close` = ✕ (modals and sheets). */
  glyph?: 'back' | 'close';
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  /** `onDark` over camera / dark washes: white glyph, dark glass. */
  surface?: GlassNavBubbleSurface;
  testID?: string;
};

export function ChromeBackButton({
  accessibilityLabel,
  glyph = 'back',
  onPress,
  style,
  surface = 'onLight',
  testID,
}: ChromeBackButtonProps) {
  const theme = useSpotlightTheme();
  const Glyph = glyph === 'close' ? IconX : IconChevronLeft;

  return (
    <GlassNavBubble
      accessibilityLabel={accessibilityLabel ?? (glyph === 'close' ? 'Close' : 'Back')}
      onPress={onPress}
      size="medium"
      style={style}
      surface={surface}
      testID={testID}
    >
      <Glyph
        color={surface === 'onDark' ? theme.colors.gray0 : theme.colors.textPrimary}
        size={glassNavBubbleGlyphSize}
        strokeWidth={glassNavBubbleGlyphStrokeWidth}
      />
    </GlassNavBubble>
  );
}
