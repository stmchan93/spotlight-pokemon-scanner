import { Text, TextInput } from 'react-native';

import { MAX_FONT_SIZE_MULTIPLIER } from '@spotlight/design-system';

/**
 * Global Dynamic Type ceiling. Without this, iOS "Larger Text" multiplies every
 * font (and its baked-in lineHeight) with no cap, blowing up our fixed-size
 * layouts. Setting a default `maxFontSizeMultiplier` on Text/TextInput caps the
 * growth app-wide — including raw `Text` usages and third-party UI we don't own.
 *
 * Explicit per-component props always win over defaultProps, so intentional
 * opt-outs (auth OTP cells, RollingNumberText's measured digit columns) and the
 * design-system primitives' own defaults are unaffected.
 *
 * `Text.defaultProps` is the long-standing RN pattern for an app-wide scaling
 * default; there is no first-class global API for it.
 */
type Defaultable = { defaultProps?: Record<string, unknown> };

const TextWithDefaults = Text as unknown as Defaultable;
const InputWithDefaults = TextInput as unknown as Defaultable;

TextWithDefaults.defaultProps = {
  ...TextWithDefaults.defaultProps,
  maxFontSizeMultiplier: MAX_FONT_SIZE_MULTIPLIER,
};

InputWithDefaults.defaultProps = {
  ...InputWithDefaults.defaultProps,
  maxFontSizeMultiplier: MAX_FONT_SIZE_MULTIPLIER,
};
