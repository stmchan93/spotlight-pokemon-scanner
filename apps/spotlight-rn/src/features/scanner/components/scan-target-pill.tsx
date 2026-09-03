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
        fallbackColor="rgba(255, 255, 255, 0.10)"
        glassColorScheme="dark"
        glassEffectStyle="clear"
        style={styles.pill}
        testID={testID ? `${testID}-surface` : undefined}
      >
        <Text style={styles.label}>{label}</Text>
        {flag ? <RoundFlag language={flag} size={14} /> : null}
        <IconChevronDown color={colors.gray0} size={20} strokeWidth={2} />
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    ...textStyles.body,
    color: colors.gray0,
  },
  pressable: {
    alignSelf: 'stretch',
    borderRadius: 999,
  },
  pill: {
    alignItems: 'center',
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
