import { IconChevronDown } from '@tabler/icons-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { GlassSurface, Text, colors, textStyles } from '@spotlight/design-system';

import { RoundFlag } from './round-flag';

/**
 * The "Pokémon EN/JP" scan-target control, centered in the scanner's top
 * toolbar: dark-pinned clear glass with white content — the SCAN/TOTAL pill
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
        <Text style={styles.label}>{label}</Text>
        {flag ? <RoundFlag language={flag} size={14} /> : null}
        <IconChevronDown color={colors.gray900} size={20} strokeWidth={2} />
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /*
    `bodyLarge`, not the `control` role every other pill uses. Figma 5085:15158
    specifies Plus Jakarta Sans REGULAR 16 here, and the reason survives the
    spec: this label is the name of what you are scanning, not a command, so the
    SemiBold that suits "ADD" or "Set all" would read as an instruction.
  */
  label: {
    ...textStyles.bodyLarge,
    color: colors.gray900,
  },
  pressable: {
    alignSelf: 'stretch',
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
