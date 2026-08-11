import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
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
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Figma "Home" 3523:15499 (toolbar 3567:22969) — 40pt tall, level with the 40pt
 * `GlassNavBubble`s (`size="compact"`) either side of it.
 */
const PILL_HEIGHT = 40;

/**
 * A tappable search ENTRY — a pill that looks like a search field but is a
 * button: pressing it opens a real search surface elsewhere. Use it in top bars
 * where search is a destination, not an inline filter (`SearchField` is the
 * primitive for actually typing into).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ITS EDGE IS A SHADOW, NOT A STROKE — that is what the frame draws.
 * ───────────────────────────────────────────────────────────────────────────
 * This shipped as a 0.5pt `gray200` hairline with no shadow, which is 1.23:1
 * against the white bar it sits on; the fill is 1.07:1. Nothing defined the
 * shape, and testers reported search as "hard to find". `shadows.searchPill`
 * carries the frame's `0 8 40 rgba(0,0,0,.12)` instead, and the stroke is gone
 * because the frame has none.
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
  style,
  testID,
}: SearchEntryPillProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        theme.shadows.searchPill,
        {
          backgroundColor: theme.colors.gray50,
          borderRadius: theme.radii.pill,
          opacity: pressed ? 0.84 : 1,
        },
        style,
      ]}
      testID={testID}
    >
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
