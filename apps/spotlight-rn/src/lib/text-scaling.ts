/**
 * Dynamic Type ceiling — how it's enforced, and why NOT here.
 *
 * This file used to set `Text.defaultProps.maxFontSizeMultiplier` to cap iOS
 * "Larger Text" app-wide. That silently BROKE: React 19 (and RN 0.83, which
 * gates it behind `reduceDefaultPropsInText`) ignore `defaultProps` on the
 * function-component `Text`/`TextInput`, so the cap became a no-op and large
 * accessibility fonts blew up every fixed-width layout (truncated nav labels,
 * chips, headers, etc.). There is no first-class global API to replace it.
 *
 * The cap is now enforced at the source instead:
 *   - Design-system primitives import a capped `Text` from
 *     `packages/design-system/src/components/scaled-text.tsx` (re-exported as
 *     `Text` from `@spotlight/design-system`) — it defaults `maxFontSizeMultiplier`
 *     to `MAX_FONT_SIZE_MULTIPLIER`.
 *   - `AppText`, `SearchField`, and `TextField` set the cap explicitly.
 *   - App chrome that renders text imports the capped `Text` from the design
 *     system rather than from `react-native`.
 *
 * New text should use the capped `Text` (or `AppText`) from `@spotlight/design-system`,
 * not a raw `react-native` `Text`, so scaling stays bounded.
 */

export {};
