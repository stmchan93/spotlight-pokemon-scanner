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
 * The capsule's geometry, taken from `GlassButtonGroup` rather than restated —
 * it is the same grouped-toolbar shape (Figma 3686:55175), and the Home bar's
 * layout is solved from these four numbers.
 */
export const glassNavBubbleGroupMetrics = {
  /** 40pt — level with `glassNavBubbleSizes.compact` and the search pill. */
  height: glassButtonGroupHeight,
  /** 36pt — the symbol frame inside, NOT a bubble of its own. */
  slotSize: glassButtonGroupControlSize,
  paddingHorizontal: glassButtonGroupPaddingHorizontal,
  gap: glassButtonGroupGap,
} as const;

/**
 * Width of a capsule holding `slotCount` symbols:
 * `6 + 36n + 6(n−1) + 6`, i.e. **90 for the two-slot bell + `+` pair**.
 *
 * Exported and used as an explicit `width` rather than left to auto-layout,
 * because the number is load-bearing: Figma's Home toolbar (3523:15499 →
 * 3567:22969) closes at `16 + 40 + 8 + 215 + 8 + 90 + 16 = 393`, so the flexed
 * search pill only lands on its 215 if the trailing control is exactly 90. Two
 * separate 40pt bubbles with the row's 8pt gap measure 88 and leave the pill
 * 2pt over.
 */
export function glassNavBubbleGroupWidth(slotCount: number): number {
  if (slotCount <= 0) {
    return 0;
  }
  const { gap, paddingHorizontal, slotSize } = glassNavBubbleGroupMetrics;
  return paddingHorizontal * 2 + slotSize * slotCount + gap * (slotCount - 1);
}

/**
 * Vertical slop is free — the capsule is 40 in a row with 8pt of padding above
 * and below it, so 8 each way takes every slot to 52 tall without colliding
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
 * (36 + 4 + 4). The gap between slots is only 6, so neighbouring targets
 * overlap across its middle 2pt and the LATER sibling wins there — an
 * ambiguous tap in the 2pt seam between two adjacent controls, which is the
 * right trade against leaving either slot under 44.
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
  /** Same meaning as on `GlassNavBubble`: what is UNDERNEATH, not the material. */
  surface?: GlassNavBubbleSurface;
  /** Positioning/layout is the consumer's; the primitive only draws the shell. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Several nav controls sharing ONE glass capsule — Home's trailing bell + `+`
 * pair (Figma "Home" 3523:15499 → toolbar 3567:22969 → `Trailing` →
 * `Button Group 1`, a single 90×40 `BG` with 36pt symbol frames at x=6 and
 * x=48). Apple's iOS 26 grouped-toolbar pattern.
 *
 * IT IS ONE SURFACE, NOT TWO. The whole point is that the material spans both
 * controls: the glass is a single `GlassSurface` filling the capsule, and on
 * every non-glass target the FALLBACK is likewise one capsule. Nesting two
 * fallback circles inside a container would give Android and iOS < 26 a pair of
 * chips in a box, which is the look this exists to remove.
 *
 * WHY NOT `GlassButtonGroup`. Same geometry — this reads its 6/6/36/40 straight
 * off that primitive — but three things differ and each of them matters here:
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
  surface = 'onLight',
  style,
  testID,
}: GlassNavBubbleGroupProps) {
  const theme = useSpotlightTheme();
  const onDark = surface === 'onDark';
  const hasGlass = isLiquidGlassAvailable();
  const radius = glassNavBubbleGroupMetrics.height / 2;
  const lastIndex = items.length - 1;

  // Only applied when the real material is absent — on glass, a hairline ring
  // or an opaque fill would fight the material's own edge and refraction. Same
  // two tones `GlassNavBubble` uses, so a grouped control and a lone one are
  // the same object on every fallback target.
  const fallbackShell = onDark
    ? { borderColor: theme.colors.gray0, borderWidth: 1 }
    : [theme.shadows.card, { backgroundColor: theme.colors.canvasElevated }];

  return (
    <View
      style={[
        styles.group,
        { borderRadius: radius, width: glassNavBubbleGroupWidth(items.length) },
        hasGlass ? null : fallbackShell,
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
    gap: glassNavBubbleGroupMetrics.gap,
    height: glassNavBubbleGroupMetrics.height,
    // NOT `hidden`, unlike `GlassButtonGroup`. Badges hang past the capsule's
    // edge (Home's unread count sits at `top: -2, right: -2` on the bell), and
    // the fallback's drop shadow needs to escape too. The material clips itself
    // to `borderRadius` without help.
    overflow: 'visible',
    paddingHorizontal: glassNavBubbleGroupMetrics.paddingHorizontal,
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
    height: glassNavBubbleGroupMetrics.slotSize,
    justifyContent: 'center',
    // See the capsule's own note — a badge on a slot must not be clipped here
    // either.
    overflow: 'visible',
    width: glassNavBubbleGroupMetrics.slotSize,
  },
});
