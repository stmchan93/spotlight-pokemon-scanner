import { IconChevronDown } from '@tabler/icons-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { GlassSurface, Text, colors, textStyles } from '@spotlight/design-system';

import { RoundFlag } from './round-flag';

/**
 * The "Scanning for Pokémon EN/JP" control, floating over the viewfinder.
 *
 * GLASS ON iOS 26, the same dark scrim as before everywhere else. `GlassSurface`
 * draws the real material where the platform has it and falls back to
 * `scannerChromeFill` — which is exactly what this pill was hard-coded to — so
 * Android and iOS < 26 are pixel-identical to what shipped.
 *
 * `glassColorScheme="dark"` is deliberate, not a default: `auto` follows the
 * SYSTEM appearance, and a light material over a near-black camera feed washes
 * out to an opaque white puck (see `glass-nav-bubble.tsx`). Everything on this
 * screen sits on the viewfinder, so it always wants the dark material.
 *
 * `clear` rather than `regular` because the frame shows the camera through the
 * pill; `bottom-tab-bar.tsx` is the other `clear` user.
 *
 * HEIGHT IS LOAD-BEARING. `rawScannerControlsRowHeight` (36) in
 * `raw-scanner-capture-surface.tsx` reserves this row's height, and the reticle
 * inset is computed from it — and the reticle IS the capture crop. Growing this
 * pill silently changes what gets cropped, and therefore match accuracy. The
 * language coach-mark is positioned off the same number.
 */
export function ScanTargetPill({
  label,
  flag,
  onPress,
  testID,
}: {
  label: string;
  /** Round language flag shown after the label (Figma 2302:28968). */
  flag?: 'en' | 'jp';
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Scanning for ${label}. Change scan target`}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.pressable, pressed && styles.pillPressed]}
      testID={testID}
    >
      <GlassSurface
        fallbackColor={colors.scannerChromeFill}
        glassColorScheme="dark"
        glassEffectStyle="clear"
        style={styles.pill}
        testID={testID ? `${testID}-surface` : undefined}
      >
        <Text style={styles.label}>{label}</Text>
        {flag ? <RoundFlag language={flag} size={13} /> : null}
        <IconChevronDown color={colors.gray0} size={20} strokeWidth={2} />
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    // Figma 1180-1278 "Label" — Plus Jakarta Sans Medium 13 (not the default
    // 15/SemiBold control role), white over the translucent pill.
    ...textStyles.label,
    color: colors.gray0,
  },
  // The Pressable owns the press feedback; the glass owns the shape and fill,
  // so the material clips the children rather than sitting behind them.
  pressable: {
    borderRadius: 999,
  },
  pill: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    // 36 — see the note above. Do not change without re-checking the reticle.
    height: 36,
    overflow: 'hidden',
    paddingHorizontal: 16,
  },
  pillPressed: {
    opacity: 0.85,
  },
});
