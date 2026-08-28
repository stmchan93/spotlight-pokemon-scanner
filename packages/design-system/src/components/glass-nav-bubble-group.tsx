import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import {
  glassButtonGroupControlSize,
  glassButtonGroupGap,
  glassButtonGroupHeight,
  glassButtonGroupPaddingHorizontal,
} from './glass-button-group';
import type { GlassNavBubbleSurface } from './glass-nav-bubble';
import { GlassSurface, isLiquidGlassAvailable } from './glass-surface';

/**
 * The capsule's geometry per named size.
 *
 * - `compact` — taken from `GlassButtonGroup` rather than restated: it is the
 *   same grouped-toolbar shape (Figma 3686:55175), 40pt tall with 36pt symbol
 *   frames on a 6pt gap.
 * - `medium` — the 44pt Home toolbar capsule (Figma 4299:94902): same 36pt
 *   symbol frames, but 44 tall to sit level with `glassNavBubbleSizes.medium`
 *   bubbles, and a 20pt gap between slots so two glyphs read as two controls
 *   rather than one crowded pair.
 */
export const glassNavBubbleGroupSizes = {
  compact: {
    height: glassButtonGroupHeight,
    slotSize: glassButtonGroupControlSize,
    paddingHorizontal: glassButtonGroupPaddingHorizontal,
    gap: glassButtonGroupGap,
  },
  medium: {
    height: 44,
    slotSize: glassButtonGroupControlSize,
    paddingHorizontal: glassButtonGroupPaddingHorizontal,
    gap: 20,
  },
} as const;

export type GlassNavBubbleGroupSize = keyof typeof glassNavBubbleGroupSizes;

/**
 * The original single-size metrics export, kept as an alias of `compact` so
 * existing readers (tests, layout arithmetic) keep working unchanged.
 */
export const glassNavBubbleGroupMetrics = glassNavBubbleGroupSizes.compact;

/**
 * Width of a capsule holding `slotCount` symbols:
 * `padding + slot·n + gap·(n−1) + padding`.
 *
 * - `compact`: `6 + 36n + 6(n−1) + 6` → **90 for two slots** (the profile bar's
 *   old edit + share pair).
 * - `medium`: `6 + 36n + 20(n−1) + 6` → **104 for the two-slot search + bell
 *   pair** on Home (Figma 4299:94902).
 *
 * Exported and used as an explicit `width` rather than left to auto-layout,
 * because the number is load-bearing: the bar's flexed middle only lands on its
 * designed width if the trailing control measures exactly this.
 */
export function glassNavBubbleGroupWidth(
  slotCount: number,
  size: GlassNavBubbleGroupSize = 'compact',
): number {
  if (slotCount <= 0) {
    return 0;
  }
  const { gap, paddingHorizontal, slotSize } = glassNavBubbleGroupSizes[size];
  return paddingHorizontal * 2 + slotSize * slotCount + gap * (slotCount - 1);
}

/**
 * Vertical slop is free — the capsule sits in a row with padding above and
 * below it, so 8 each way takes every slot past 44pt tall without colliding
 * with anything.
 */
const HIT_SLOP_VERTICAL = 8;
/**
 * Outside edge: 8, matching `GlassNavBubble`'s uniform slop, so the outermost
 * slots stay as reachable as a standalone bubble.
 */
const HIT_SLOP_OUTER = 8;
/**
 * Inside edge: 4, which is what takes a 36pt slot to the 44pt touch minimum
 * (36 + 4 + 4). On `compact` the gap between slots is only 6, so neighbouring
 * targets overlap across its middle 2pt and the LATER sibling wins there — an
 * ambiguous tap in the 2pt seam between two adjacent controls, which is the
 * right trade against leaving either slot under 44. `medium`'s 20pt gap holds
 * the two targets 12pt clear of each other.
 */
const HIT_SLOP_INNER = 4;

export type GlassNavBubbleGroupItem = {
  accessibilityLabel: string;
  /** The glyph. Icon color stays the caller's call, as on `GlassNavBubble`. */
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
};

export type GlassNavBubbleGroupProps = {
  /**
   * One entry per symbol slot, left to right. An ARRAY rather than `children`
   * so the primitive can size itself from the count and vary each slot's
   * `hitSlop` by position — neither is possible with opaque children.
   */
  items: GlassNavBubbleGroupItem[];
  /**
   * `compact` (40pt, 6pt gap — the profile/action-bar shape) or `medium`
   * (44pt, 20pt gap — the Home toolbar). Defaults to `compact`.
   */
  size?: GlassNavBubbleGroupSize;
  /** Same meaning as on `GlassNavBubble`: what is UNDERNEATH, not the material. */
  surface?: GlassNavBubbleSurface;
  /** Positioning/layout is the consumer's; the primitive only draws the shell. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Several nav controls sharing ONE glass capsule — Home's trailing search +
 * bell pair (Figma 4299:94902: a single 104×44 capsule with 36pt symbol frames
 * on a 20pt gap) and the profile toolbar's edit + share pair. Apple's iOS 26
 * grouped-toolbar pattern.
 *
 * IT IS ONE SURFACE, NOT TWO. The whole point is that the material spans both
 * controls: the glass is a single `GlassSurface` filling the capsule, and on
 * every non-glass target the FALLBACK is likewise one capsule. Nesting two
 * fallback circles inside a container would give Android and iOS < 26 a pair of
 * chips in a box, which is the look this exists to remove.
 *
 * WHY NOT `GlassButtonGroup`. Same geometry — `compact` reads its 6/6/36/40
 * straight off that primitive — but three things differ and each of them
 * matters here:
 *
 * 1. The fallback has to be `canvasElevated` + `shadows.card`, matching the
 *    `GlassNavBubble` sitting at the other end of the same row. `GlassButtonGroup`
 *    falls back to a flat `gray50` with no lift, which beside a shadowed menu
 *    bubble reads as two different chrome styles in one bar.
 * 2. `overflow` must stay VISIBLE. Home's unread badge hangs off the bell at
 *    `top: -2, right: -2`; `GlassButtonGroup` clips its material with
 *    `overflow: 'hidden'` and would shave it.
 * 3. It owns its pressables, so each 36pt slot can carry position-dependent
 *    `hitSlop` and clear 44pt. `GlassButtonGroup` takes arbitrary children and
 *    cannot reason about which of them is on an outside edge.
 *
 * Real iOS 26 glass only; everywhere else a solid capsule, never a blur/rgba
 * imitation — see `glass-surface.tsx`.
 */
export function GlassNavBubbleGroup({
  items,
  size = 'compact',
  surface = 'onLight',
  style,
  testID,
}: GlassNavBubbleGroupProps) {
  const theme = useSpotlightTheme();
  const onDark = surface === 'onDark';
  const hasGlass = isLiquidGlassAvailable();
  const metrics = glassNavBubbleGroupSizes[size];
  const radius = metrics.height / 2;
  const lastIndex = items.length - 1;

  // Only applied when the real material is absent — on glass, a hairline ring
  // or an opaque fill would fight the material's own edge and refraction. Same
  // two tones `GlassNavBubble` uses, so a grouped control and a lone one are
  // the same object on every fallback target.
  const fallbackShell = onDark
    ? { borderColor: theme.colors.gray0, borderWidth: 1 }
    : [theme.shadows.glassPill, { backgroundColor: theme.colors.glassFallback }];

  return (
    <View
      style={[
        styles.group,
        {
          borderRadius: radius,
          gap: metrics.gap,
          height: metrics.height,
          paddingHorizontal: metrics.paddingHorizontal,
          width: glassNavBubbleGroupWidth(items.length, size),
        },
        hasGlass ? null : fallbackShell,
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
      {items.map((item, index) => (
        <Pressable
          accessibilityLabel={item.accessibilityLabel}
          accessibilityRole="button"
          disabled={item.disabled}
          hitSlop={{
            bottom: HIT_SLOP_VERTICAL,
            left: index === 0 ? HIT_SLOP_OUTER : HIT_SLOP_INNER,
            right: index === lastIndex ? HIT_SLOP_OUTER : HIT_SLOP_INNER,
            top: HIT_SLOP_VERTICAL,
          }}
          key={item.testID ?? item.accessibilityLabel}
          onPress={item.onPress}
          style={({ pressed }) => [
            styles.slot,
            { height: metrics.slotSize, width: metrics.slotSize },
            // The SLOT dims, not the capsule: pressing one control must not
            // fade the material out from under its neighbour.
            { opacity: item.disabled ? 0.45 : pressed ? 0.84 : 1 },
          ]}
          testID={item.testID}
        >
          {item.children}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    alignItems: 'center',
    flexDirection: 'row',
    // NOT `hidden`, unlike `GlassButtonGroup`. Badges hang past the capsule's
    // edge (Home's unread count sits at `top: -2, right: -2` on the bell), and
    // the fallback's drop shadow needs to escape too. The material clips itself
    // to `borderRadius` without help.
    overflow: 'visible',
  },
  glass: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
    // See the capsule's own note — a badge on a slot must not be clipped here
    // either.
    overflow: 'visible',
  },
});
