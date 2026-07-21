import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, View, type ViewProps } from 'react-native';

/**
 * Re-exported so screens can gate their own layout (e.g. pinning a header so
 * content scrolls under the glass) on real Liquid Glass availability without
 * importing `expo-glass-effect` directly — the native dep stays owned here.
 */
export { isLiquidGlassAvailable } from 'expo-glass-effect';

export type GlassSurfaceProps = ViewProps & {
  /**
   * Solid background used on every target that is NOT real iOS 26 Liquid Glass
   * (Android + iOS < 26 + iOS 26 with the effect disabled via accessibility).
   * Pass the surface's existing token color so the fallback is byte-identical to
   * today's look — never a blur/rgba imitation of glass.
   */
  fallbackColor: string;
  /** Optional tint applied to the real iOS 26 Liquid Glass material. */
  glassTintColor?: string;
  /**
   * Glass appearance. Set to match the app's own theme toggle rather than the
   * system when they can diverge; defaults to following the system (`auto`).
   */
  glassColorScheme?: 'auto' | 'light' | 'dark';
};

/**
 * Renders the real native iOS 26 "Liquid Glass" material (`expo-glass-effect`'s
 * `GlassView`, i.e. `UIGlassEffect`) when — and only when — it is genuinely
 * available: an iOS 26 device running a binary compiled with the iOS 26 SDK.
 * Everywhere else it renders a plain solid `View` in `fallbackColor`, so the
 * surface looks exactly like it does today.
 *
 * Deliberately has NO `BlurView`/translucent-`rgba` branch: a frosted-blur
 * knockoff reads as a non-native imitation, which is the failure mode a prior
 * attempt shipped and reverted. Glass only appears via a fresh native build,
 * never OTA. The caller owns the shape (radius, size, overflow clip) via `style`.
 */
export function GlassSurface({
  fallbackColor,
  glassTintColor,
  glassColorScheme = 'auto',
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  if (Platform.OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView
        colorScheme={glassColorScheme}
        glassEffectStyle="regular"
        style={style}
        tintColor={glassTintColor}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[style, { backgroundColor: fallbackColor }]} {...rest}>
      {children}
    </View>
  );
}
