import { Text as RNText, type TextProps } from 'react-native';

import { MAX_FONT_SIZE_MULTIPLIER } from '../tokens';

/**
 * A drop-in replacement for React Native's `Text` that applies the app-wide
 * Dynamic Type ceiling (`MAX_FONT_SIZE_MULTIPLIER`) by default.
 *
 * Why this exists: the old global cap set `Text.defaultProps`, but React 19
 * ignores `defaultProps` on RN's function-component `Text`, so that cap silently
 * became a no-op and iOS "Larger Text" blew up every fixed-width layout. Design-
 * system primitives import `Text` from here instead of `react-native` so the cap
 * is enforced at the source. A caller can still override it explicitly
 * (e.g. `allowFontScaling={false}` or a custom `maxFontSizeMultiplier`).
 */
export function Text({ maxFontSizeMultiplier = MAX_FONT_SIZE_MULTIPLIER, ...props }: TextProps) {
  return <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} />;
}
