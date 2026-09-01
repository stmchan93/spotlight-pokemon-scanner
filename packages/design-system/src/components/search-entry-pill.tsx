import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { GlassSurface, isLiquidGlassAvailable } from './glass-surface';
import { useSpotlightTheme } from '../theme';

type SearchEntryPillProps = {
  /** Placeholder-style copy, e.g. "Search Cards". */
  label: string;
  onPress?: () => void;
  /** Defaults to `label`. */
  accessibilityLabel?: string;
  /**
   * Optional badge at the leading edge (the app mark in the feed top bar). It
   * is an in-flow row item, so badge and label read as ONE left-aligned group
   * — Figma "Home" 3523:15499 starts the mark 8pt in from the pill's left edge
   * and the label 4pt after it, rather than centring the copy in the full pill.
   */
  leading?: ReactNode;
  /**
   * `solid` — the original `gray50` fill with the 1pt `searchBorder` stroke.
   * `glass` — the same Liquid Glass shell as the `GlassNavBubble`s beside it
   * (Figma 4134:49518): real glass on iOS 26; elsewhere the `glassFallback`
   * fill with the `glassPill` lift and NO stroke — the material's edge (or the
   * fallback's shadow) is what defines the shape, so a border would double it.
   */
  variant?: 'solid' | 'glass';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Figma 4299:94902 — 44pt tall, level with the 44pt `GlassNavBubble`s
 * (`size="medium"`) either side of it in the profile top bar.
 */
const PILL_HEIGHT = 44;

/**
 * A tappable search ENTRY — a pill that looks like a search field but is a
 * button: pressing it opens a real search surface elsewhere. Use it in top bars
 * where search is a destination, not an inline filter (`SearchField` is the
 * primitive for actually typing into).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * A 1pt `searchBorder` STROKE, NOT A SHADOW. Read this before "fixing" it back.
 * ───────────────────────────────────────────────────────────────────────────
 * This shipped as a 0.5pt `gray200` hairline — 1.23:1 against the white bar it
 * sits on, over a 1.07:1 fill. Nothing described the shape, and testers
 * reported search as "hard to find".
 *
 * The frame (3567:22980) draws the edge as a shadow, `0 8 40 rgba(0,0,0,.12)`,
 * with no stroke, and that was tried. It does not survive the platform: RN
 * collapses a shadow to `elevation` on Android, which derives a RECTANGULAR
 * outline, so a rounded pill came out looking boxed. Reported immediately.
 *
 * So the edge is a real stroke instead: `searchBorder` `#BEBEBE` at 1pt, which
 * is 1.86:1 — visible on both platforms and identical on both, which the
 * shadow could never be. It is the token the design system already keeps for
 * exactly this (`SearchField`'s `compact` variant uses it at the same width).
 *
 * The label is `bodySmall` in `gray600` for the same reason: the frame
 * specifies 14pt Regular `#717171`, which is exactly `bodySmall` — despite the
 * name, it is the 14pt REGULAR role (`body` is 15pt). The `label`/`gray500` it
 * drifted to measured 2.44:1, under WCAG AA. The design was already right.
 */
export function SearchEntryPill({
  label,
  onPress,
  accessibilityLabel,
  leading,
  variant = 'solid',
  style,
  testID,
}: SearchEntryPillProps) {
  const theme = useSpotlightTheme();
  const glass = variant === 'glass';
  const hasGlass = glass && isLiquidGlassAvailable();

  const shell = glass
    ? hasGlass
      ? null
      : [theme.shadows.glassPill, { backgroundColor: theme.colors.glassFallback }]
    : {
        backgroundColor: theme.colors.gray50,
        borderColor: theme.colors.searchBorder,
        borderWidth: 1,
      };

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        { borderRadius: theme.radii.pill },
        shell,
        { opacity: pressed ? 0.84 : 1 },
        style,
      ]}
      testID={testID}
    >
      {glass ? (
        <GlassSurface
          fallbackColor={theme.colors.glassFallback}
          glassColorScheme="auto"
          glassEffectStyle="regular"
          pointerEvents="none"
          style={[styles.glass, { borderRadius: theme.radii.pill }]}
        />
      ) : null}
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Text
        numberOfLines={1}
        style={[theme.typography.bodySmall, styles.label, { color: theme.colors.gray600 }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  glass: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // Shrinks rather than pushing the badge off the leading edge when the pill is
  // narrow; `numberOfLines={1}` then truncates the copy.
  label: {
    flexShrink: 1,
  },
  leading: {
    justifyContent: 'center',
  },
  pill: {
    alignItems: 'center',
    flexDirection: 'row',
    // Badge and label are ONE group starting at the leading edge: 8pt inset,
    // 4pt between them (Figma "Home" 3523:15499). It read as centred copy with
    // a badge floating beside it before, which is not what the frame draws.
    gap: 4,
    height: PILL_HEIGHT,
    paddingHorizontal: 8,
  },
});
