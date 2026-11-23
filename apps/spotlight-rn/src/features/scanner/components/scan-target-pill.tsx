import { Pressable, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { GlassSurface, Text, colors, textStyles } from '@spotlight/design-system';

import { RoundFlag } from './round-flag';

/**
 * The "Pokémon EN/JP" scan-target control: a content-sized pill centred over
 * the scanner's frame (Figma Scan-1 6642:5410): dark-pinned clear glass with white content — the SCAN/TOTAL pill
 * recipe. Light glass borrows brightness from the backdrop and vanished over
 * night scenes; dark glass + white text reads over any camera content.
 */
export function ScanTargetPill({
  label,
  flag,
  onPress,
  testID,
}: {
  label: string;
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
        // Light frost with a white tint floor (see colors.frostTint); regular,
        // not clear — clear glass is what vanished over dark scenes.
        fallbackColor={colors.gray0}
        glassColorScheme="light"
        glassEffectStyle="regular"
        glassTintColor={colors.frostTint}
        style={styles.pill}
        testID={testID ? `${testID}-surface` : undefined}
      >
        <Text style={styles.label}>{label.toUpperCase()}</Text>
        {flag ? <RoundFlag language={flag} size={18} /> : null}
        <PillChevron />
      </GlassSurface>
    </Pressable>
  );
}

// SF chevron.down at the Figma glyph box (14×8); a 24-box icon set can't hit
// that box without padding the row's 6pt gaps.
function PillChevron() {
  return (
    <Svg height={8} testID="scan-target-pill-chevron" viewBox="0 0 14 8" width={14}>
      <Path
        d="M1 1L7 7L13 1"
        fill="none"
        stroke={colors.gray900}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  // Figma Label (Medium 14) on every Scan-1 frame (type-scale migration
  // 2026-10-18); the earlier REGULAR 16 spec (5085:15158) is superseded.
  label: {
    ...textStyles.label,
    color: colors.gray900,
  },
  // Sized to its content (label + flag + chevron + padding), never stretched.
  pressable: {
    alignSelf: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
  },
  pill: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 16,
  },
  pillPressed: {
    opacity: 0.85,
  },
});
