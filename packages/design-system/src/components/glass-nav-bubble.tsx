import type { ReactNode } from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { GlassSurface, isLiquidGlassAvailable } from './glass-surface';

/**
 * Diameter (pt) of each named bubble size. Exported so screens that lay bubbles
 * out themselves (e.g. the Collection corner stack, which offsets each bubble by
 * `diameter + gap`) can do the maths from the token instead of a local literal.
 */
export const glassNavBubbleSizes = {
  /** 32pt — dense chrome floating over a live surface (scanner viewfinder). */
  small: 32,
  /**
   * 36pt — a bubble sharing a top bar with other controls, sized to sit level
   * with the 36pt `SearchEntryPill` between them (the Home header). Below the
   * 44pt touch minimum on its own, which the primitive's 8pt `hitSlop` covers.
   */
  compact: 36,
  /** 44pt — the standard floating nav bubble (Collection / Wishlist). */
  medium: 44,
} as const;

export type GlassNavBubbleSize = keyof typeof glassNavBubbleSizes;

/**
 * Describes the SURFACE the bubble floats over, not the glass material. Callers
 * should never have to reason about `UIGlassEffect` color schemes — say what is
 * underneath and the primitive picks the material and the non-glass fallback.
 *
 * - `onLight` — light, scrolling app content (Collection list, Wishlist header).
 * - `onDark` — a dark, moving backdrop (the scanner's camera feed).
 */
export type GlassNavBubbleSurface = 'onLight' | 'onDark';

export type GlassNavBubbleProps = {
  accessibilityLabel: string;
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  size?: GlassNavBubbleSize;
  surface?: GlassNavBubbleSurface;
  /**
   * Positioning is owned by the consumer (typically absolute, pinned to a
   * corner). The primitive only renders the circular shell + its content.
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A floating circular Liquid Glass nav button — the shared top-corner chrome
 * used by Collection, the scanner viewfinder, and the Wishlist header.
 *
 * Real iOS 26 glass (`GlassSurface` → `UIGlassEffect`, `regular` material) sits
 * behind the content so the backdrop refracts under it as the screen scrolls or
 * the camera moves. Everywhere else the `surface` tone decides a solid fallback;
 * there is deliberately no blur/rgba imitation branch anywhere in this stack
 * (see `glass-surface.tsx`).
 *
 * Why `surface` and not a raw color scheme: `glassColorScheme="auto"` follows
 * the SYSTEM light/dark setting, which says nothing about what is actually
 * behind the bubble. Over the scanner's camera feed the system could be in
 * light mode while the backdrop is near-black, and a light material would wash
 * out to an opaque white puck. `onDark` therefore pins the material to `dark`.
 * `onLight` keeps `auto`, because those bubbles sit next to UIKit's own native
 * tab bar — that bar is system-driven glass we do not get to configure, so the
 * chrome has to meet it rather than the other way round.
 *
 * Fallbacks (Android, iOS < 26, glass off for accessibility):
 * - `onLight` → solid `canvasElevated` circle with the `shadows.card` lift, so
 *   it still reads as a raised chip against light scrolling content.
 * - `onDark` → transparent fill with a 1pt `gray0` hairline ring. A solid light
 *   circle would punch a bright hole in the viewfinder and hide the frame the
 *   user is aiming; the ring stays legible over any camera content and casts no
 *   shadow (there is no lit surface for one to fall on).
 *
 * The glyph is passed in as `children`, so icon color stays the caller's call:
 * dark (`gray900`) on light surfaces, white (`gray0`) on the scanner.
 */
export function GlassNavBubble({
  accessibilityLabel,
  children,
  onPress,
  disabled = false,
  size = 'medium',
  surface = 'onLight',
  style,
  testID,
}: GlassNavBubbleProps) {
  const theme = useSpotlightTheme();
  const diameter = glassNavBubbleSizes[size];
  const radius = diameter / 2;
  const onDark = surface === 'onDark';
  const hasGlass = isLiquidGlassAvailable();

  // Only applied when the real material is absent — on glass, a hairline ring or
  // an opaque fill would fight the material's own edge and refraction.
  const fallbackShell = onDark
    ? { borderColor: theme.colors.gray0, borderWidth: 1 }
    : [theme.shadows.card, { backgroundColor: theme.colors.canvasElevated }];

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.bubble,
        { borderRadius: radius, height: diameter, width: diameter },
        hasGlass ? null : fallbackShell,
        { opacity: disabled ? 0.45 : pressed ? 0.84 : 1 },
        style,
      ]}
      testID={testID}
    >
      <GlassSurface
        fallbackColor={onDark ? 'transparent' : theme.colors.canvasElevated}
        glassColorScheme={onDark ? 'dark' : 'auto'}
        glassEffectStyle="regular"
        pointerEvents="none"
        style={[styles.glass, { borderRadius: radius }]}
      />
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bubble: {
    alignItems: 'center',
    justifyContent: 'center',
    // Badges (e.g. the Collection notification count) are allowed to hang past
    // the circle's edge, so the shell must not clip.
    overflow: 'visible',
  },
  glass: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
