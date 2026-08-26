import { StyleSheet, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { GlassSurface, isLiquidGlassAvailable } from './glass-surface';

/** 44pt — level with `glassNavBubbleSizes.medium` (Figma toolbars, 4299:94908). */
const GROUP_HEIGHT = 44;
/** Inset and spacing around the 36pt controls inside (Figma 3686:55175). */
const GROUP_PADDING_HORIZONTAL = 6;
const GROUP_GAP = 6;

/**
 * The grouped-toolbar geometry, exported because `GlassNavBubbleGroup` is the
 * SAME shape with a different fallback and its own pressables, and the Home
 * bar's layout depends on the exact width the numbers produce (a 90pt trailing
 * capsule is what leaves the search pill its 215). Two copies of 6/6/36/40 that
 * could silently disagree is precisely how the pill ended up 2pt out before.
 */
export const glassButtonGroupPaddingHorizontal = GROUP_PADDING_HORIZONTAL;
export const glassButtonGroupGap = GROUP_GAP;

export type GlassButtonGroupProps = ViewProps & {
  /**
   * Solid fill off iOS 26 Liquid Glass. Defaults to `glassFallback` (Figma
   * 4211:83834's composited "Fill + Shadow" gray) to match `GlassNavBubble` —
   * they sit side by side, and two fallbacks for one material read as two
   * colours on the platform with no glass to hide it.
   *
   * Pass a colour for anything that is not a white page; the scanner does.
   */
  fallbackColor?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Two or more toolbar controls sharing ONE glass surface — the trailing
 * delete/share pair on card detail, and edit/share on your profile
 * (Figma 3686:55167, 3670:47454).
 *
 * The point is that it is one surface, not two. Rendering each control in its
 * own bubble reads as two unrelated buttons that happen to be adjacent; a
 * single pill reads as one group of related actions, which is what they are.
 *
 * CHILDREN SHOULD CARRY NO FILL OF THEIR OWN — pass `variant="ghost"`
 * `IconButton`s (or equivalent) sized 36. A filled child inside this puts a
 * circle inside a pill, which is the look this exists to remove.
 *
 * Also usable with a SINGLE child, which is how a lone 40pt control (the back
 * button) stays in the same material as the group opposite it. A leading circle
 * in one material and a trailing pill in another is the inconsistency the
 * grouping was meant to fix.
 *
 * Real glass only on iOS 26; everywhere else the solid `fallbackColor`, never a
 * blur imitation — see `GlassSurface`.
 */
export function GlassButtonGroup({
  children,
  fallbackColor,
  style,
  ...rest
}: GlassButtonGroupProps) {
  const theme = useSpotlightTheme();
  // Only without glass — on glass a shadow fights the material's own edge.
  const fallbackShell = isLiquidGlassAvailable() ? null : theme.shadows.glassPill;
  return (
    <GlassSurface
      fallbackColor={fallbackColor ?? theme.colors.glassFallback}
      glassEffectStyle="regular"
      style={[styles.group, { borderRadius: theme.radii.pill }, fallbackShell, style]}
      {...rest}
    >
      {children}
    </GlassSurface>
  );
}

/** Exported so callers can size their children to match the group's controls. */
export const glassButtonGroupControlSize = 36;

const styles = StyleSheet.create({
  group: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: GROUP_GAP,
    height: GROUP_HEIGHT,
    // Clips the material to the pill.
    overflow: 'hidden',
    paddingHorizontal: GROUP_PADDING_HORIZONTAL,
  },
});

/** Re-exported for layouts that need to reserve the row's height. */
export const glassButtonGroupHeight = GROUP_HEIGHT;
