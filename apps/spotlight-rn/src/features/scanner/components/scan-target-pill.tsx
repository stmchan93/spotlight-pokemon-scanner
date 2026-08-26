import { IconChevronDown } from '@tabler/icons-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { GlassSurface, Text, colors, textStyles } from '@spotlight/design-system';

import { RoundFlag } from './round-flag';

/**
 * The "Pokémon EN/JP" scan-target control, centered in the scanner's top
 * toolbar (Figma 4299:93955): light glass pill, dark 15pt label, flag, and a
 * chevron. Real glass on iOS 26; the shared `glassFallback` gray elsewhere so
 * it stays visible over the live camera.
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
        fallbackColor={colors.glassFallback}
        glassColorScheme="light"
        glassEffectStyle="regular"
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
  label: {
    ...textStyles.body,
    color: colors.gray900,
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
