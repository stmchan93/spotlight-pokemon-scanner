import { forwardRef, type ComponentRef } from 'react';
import { Text as RNText, type TextProps } from 'react-native';

import { MAX_FONT_SIZE_MULTIPLIER } from '../tokens';

/**
 * A drop-in replacement for React Native's `Text` that applies the app-wide
 * Dynamic Type ceiling (`MAX_FONT_SIZE_MULTIPLIER`) by default.
 *
 * Why this exists: the old global cap set `Text.defaultProps`, but React 19
 * ignores `defaultProps` on RN's function-component `Text`, so that cap silently
 * became a no-op and iOS "Larger Text" blew up every fixed-width layout. Design-
 * system primitives and app chrome import `Text` from here (re-exported from
 * `@spotlight/design-system`) instead of `react-native` so the cap is enforced at
 * the source. A caller can still override it explicitly (e.g. `allowFontScaling={false}`
 * or a custom `maxFontSizeMultiplier`). Refs are forwarded, so `measure()` etc. work.
 */
export const Text = forwardRef<ComponentRef<typeof RNText>, TextProps>(function Text(
  { maxFontSizeMultiplier = MAX_FONT_SIZE_MULTIPLIER, ...props },
  ref,
) {
  return <RNText ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} />;
});

Text.displayName = 'Text';
