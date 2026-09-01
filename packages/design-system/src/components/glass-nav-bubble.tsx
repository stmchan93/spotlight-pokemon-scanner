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
   * 40pt — a bubble sharing a compact top bar with other 40pt controls (the
   * Wishlist header's row, Figma 3505:14521). Below the 44pt touch minimum on
   * its own, which the primitive's 8pt `hitSlop` covers. The Home/profile bar
   * used to be a 40pt row too; it moved to `medium` with Figma 4299:94902.
   */
  compact: 40,
  /**
   * 44pt — the standard floating nav bubble, and the height of every control
   * in the Home/profile top bar (Figma 4299:94902).
   */
  medium: 44,
} as const;

export type GlassNavBubbleSize = keyof typeof glassNavBubbleSizes;

/**
 * Render size (pt) for the stroke icon inside a glass nav control.
 *
 * 24, not the 20 the Figma toolbar frames measure — because those frames
 * (4299:95118) place TIGHT-CROPPED SF-Symbol glyphs (a true ~20pt of ink at
 * ~1.5pt weight), while the app's icon sets (iconoir, tabler) pad their glyphs
 * inside a 24-unit viewBox and scale stroke weight with render size. Rendered
 * at 20 they show ~16pt of ink at ~1.25pt — the "icons look small and thin"
 * report. At 24 the visible glyph and stroke land on the frame's numbers.
 */
export const glassNavBubbleGlyphSize = 24;

/**
 * Stroke width (viewBox units) for the icon inside a glass nav control — 2.0pt
 * actual at the 24pt render. The frames' SF-Symbol glyphs measure ~1.6–2.1pt of
 * ink; the sets' default 1.5 still read thin against them, and the scanner's
 * over-camera bubbles already ran 2. One weight everywhere.
 */
export const glassNavBubbleGlyphStrokeWidth = 2;

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
 * - `onLight` → solid `glassFallback` gray circle with the `shadows.glassPill`
 *   lift (Figma 4211:83834 "Fill + Shadow") — pure white vanished on white
 *   pages.
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
    : [theme.shadows.glassPill, { backgroundColor: theme.colors.glassFallback }];

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
        fallbackColor={onDark ? 'transparent' : theme.colors.glassFallback}
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
