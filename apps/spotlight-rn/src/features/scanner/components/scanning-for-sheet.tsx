import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppText,
  Badge,
  RadioDot,
  SheetSurface,
  useSpotlightTheme,
} from '@spotlight/design-system';

import type {
  ScannerCardType,
  ScannerCondition,
} from '@/features/scanner/use-scanner-target-config';

// Trading-card games we intend to support but haven't shipped yet. Rendered as
// disabled rows with a "Coming Soon" badge per the Figma "Scanning for" sheet.
const COMING_SOON_TYPES = [
  'Lorcana',
  'Magic: The Gathering',
  'One Piece',
  'Riftbound',
  'Sports',
  'Yu-Gi-Oh',
] as const;

type ScanningForSheetProps = {
  visible: boolean;
  condition: ScannerCondition;
  cardType: ScannerCardType;
  onSelectCondition: (condition: ScannerCondition) => void;
  onSelectCardType: (cardType: ScannerCardType) => void;
  onClose: () => void;
  testID?: string;
};

export function ScanningForSheet({
  visible,
  condition,
  cardType,
  onSelectCondition,
  onSelectCardType,
  onClose,
  testID = 'scanning-for-sheet',
}: ScanningForSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View pointerEvents="box-none" style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close scan target picker"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <SheetSurface
          padding={16}
          showHandle
          testID={testID}
          tone="dark"
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
        >
          <AppText color="gray0" style={styles.title} variant="titleSmall">
            Scanning for
          </AppText>

          <View style={[styles.divider, { backgroundColor: theme.colors.gray800 }]} />

          <Section label="CONDITION">
            <OptionRow
              label="Graded"
              selected={condition === 'graded'}
              onPress={() => onSelectCondition('graded')}
              testID={`${testID}-condition-graded`}
            />
            <OptionRow
              label="Ungraded"
              selected={condition === 'ungraded'}
              onPress={() => onSelectCondition('ungraded')}
              testID={`${testID}-condition-ungraded`}
            />
          </Section>

          <View style={[styles.divider, { backgroundColor: theme.colors.gray800 }]} />

          <Section label="TYPE">
            <OptionRow
              label="Pokémon EN"
              selected={cardType === 'pokemon_en'}
              onPress={() => onSelectCardType('pokemon_en')}
              testID={`${testID}-type-pokemon-en`}
            />
            <OptionRow
              label="Pokémon JP"
              selected={cardType === 'pokemon_jp'}
              onPress={() => onSelectCardType('pokemon_jp')}
              testID={`${testID}-type-pokemon-jp`}
            />
            {COMING_SOON_TYPES.map((name) => (
              <ComingSoonRow key={name} label={name} />
            ))}
          </Section>
        </SheetSurface>
      </View>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText color="gray500" style={styles.sectionLabel} variant="overline">
        {label}
      </AppText>
      {children}
    </View>
  );
}

function OptionRow({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={testID}
    >
      <AppText color="gray0" style={styles.rowLabel} variant="body">
        {label}
      </AppText>
      <RadioDot selected={selected} tone="dark" />
    </Pressable>
  );
}

function ComingSoonRow({ label }: { label: string }) {
  return (
    <View style={styles.row}>
      <AppText color="gray600" style={styles.rowLabel} variant="body">
        {label}
      </AppText>
      <Badge label="Coming Soon" size="sm" tone="brand" />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5, 5, 5, 0.6)',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 36,
    paddingVertical: 6,
  },
  rowLabel: {
    flex: 1,
  },
  rowPressed: {
    opacity: 0.7,
  },
  section: {
    gap: 4,
  },
  sectionLabel: {
    marginBottom: 8,
  },
  sheet: {
    width: '100%',
  },
  title: {
    marginBottom: 4,
  },
});
