import { BlurView, type BlurTint } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, View, type ViewProps } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type GlassSurfaceProps = ViewProps & {
  /** Blur tint used on the older-iOS BlurView fallback. */
  tint?: 'light' | 'dark' | 'default';
  /** Optional tint color passed to the iOS 26 Liquid Glass material. */
  glassTintColor?: string;
};

/**
 * Frosted "Liquid Glass" material shell. Renders, in order of preference:
 *   - iOS 26+ : the real `GlassView` Liquid Glass material
 *   - iOS <26 : an `expo-blur` `BlurView` frosted fallback
 *   - Android : a translucent solid `View` so it still reads as a frosted bar
 *
 * The caller owns the shape (border radius, size, overflow clip) via `style`.
 */
export function GlassSurface({
  tint,
  glassTintColor,
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  const theme = useSpotlightTheme();

  if (Platform.OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        tintColor={glassTintColor}
        style={style}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={40}
        tint={(tint ?? 'light') as BlurTint}
        style={style}
        {...rest}
      >
        {children}
      </BlurView>
    );
  }

  // Android: translucent frosted fallback (no native blur material here).
  // Derive from the elevated canvas token but at ~0.82 opacity so the shell
  // still reads as a frosted bar; fall back to a literal rgba white.
  const androidBg = toTranslucent(theme.colors.canvasElevated, 0.82);

  return (
    <View style={[style, { backgroundColor: androidBg }]} {...rest}>
      {children}
    </View>
  );
}

/**
 * Convert a #RRGGBB hex token into an rgba() string with the given alpha.
 * Falls back to a translucent white if the input is not a 6-digit hex.
 */
function toTranslucent(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
  const value = match[1];
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
