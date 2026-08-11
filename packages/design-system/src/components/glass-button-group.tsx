import { StyleSheet, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { GlassSurface, isLiquidGlassAvailable } from './glass-surface';

/** 40pt — level with `glassNavBubbleSizes.compact` and the 40pt search pill. */
const GROUP_HEIGHT = 40;
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
   * Solid fill for every target that is not real iOS 26 Liquid Glass. Defaults
   * to `canvasElevated` — WHITE, and paired with the card shadow below.
   *
   * It used to default to `gray50`, matching `IconButton variant="subtle"`. That
   * was defensible on its own and wrong beside anything else: `GlassNavBubble`
   * falls back to white, so on Android the Wishlist bar drew a white menu bubble
   * next to a grey action pill, and card detail drew a grey back button and a
   * grey delete/share pair over a white page. Two fallbacks for one material is
   * how "the same chrome" ends up two colours on the platform that has no glass
   * to hide the difference.
   *
   * Pass a colour explicitly for a surface that is not a white page — the
   * scanner does, since white-on-viewfinder is not the goal there.
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
  /*
    THE SHADOW IS WHAT MAKES A WHITE PILL VISIBLE. `gray50` separated this group
    from a white page by itself; `canvasElevated` is the page colour, so without
    a raised edge the group would simply vanish on Android. Applied ONLY when the
    real material is absent — on glass it would fight the material's own edge —
    which is exactly the rule `GlassNavBubble` follows, and the reason Home's
    bubbles read as raised white chips on Android rather than as nothing.
  */
  const fallbackShell = isLiquidGlassAvailable() ? null : theme.shadows.card;
  return (
    <GlassSurface
      fallbackColor={fallbackColor ?? theme.colors.canvasElevated}
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
