import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppText,
  RadioDot,
  SheetSurface,
  colors,
} from '@spotlight/design-system';

import type { ScannerCardType } from '@/features/scanner/use-scanner-target-config';

// Trading-card games we intend to support but haven't shipped yet. Rendered as
// disabled rows with a "Coming Soon" tag per the Figma "Scanning for" sheet
// (node 1056-1472). Non-interactive — no handler.
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
  cardType: ScannerCardType;
  onSelectCardType: (cardType: ScannerCardType) => void;
  onClose: () => void;
  testID?: string;
};

// NOTE: The CONDITION (Graded/Ungraded) section was intentionally removed.
// Scanning is now always raw/visual; grading is chosen later on the product
// detail page. The slab lane is kept but gated off pending the PDP-grading flow.
export function ScanningForSheet({
  visible,
  cardType,
  onSelectCardType,
  onClose,
  testID = 'scanning-for-sheet',
}: ScanningForSheetProps) {
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
          <View style={styles.header}>
            <View style={styles.headerPill}>
              <AppText color="gray400" variant="labelStrong">
                SCANNING FOR
              </AppText>
            </View>
          </View>

          <View style={styles.list}>
            <LanguageRow
              label="Pokémon EN"
              selected={cardType === 'pokemon_en'}
              onPress={() => onSelectCardType('pokemon_en')}
              testID={`${testID}-type-pokemon-en`}
            />
            <LanguageRow
              label="Pokémon JP"
              selected={cardType === 'pokemon_jp'}
              onPress={() => onSelectCardType('pokemon_jp')}
              testID={`${testID}-type-pokemon-jp`}
            />
            {COMING_SOON_TYPES.map((name) => (
              <ComingSoonRow key={name} label={name} />
            ))}
          </View>
        </SheetSurface>
      </View>
    </Modal>
  );
}

function LanguageRow({
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
      <RadioDot selected={selected} selectedColor={colors.purple500} />
    </Pressable>
  );
}

function ComingSoonRow({ label }: { label: string }) {
  return (
    <View style={styles.row}>
      <AppText color="gray600" style={styles.rowLabel} variant="body">
        {label}
      </AppText>
      <View style={styles.comingSoonTag}>
        <AppText color="gray400" variant="overline">
          Coming Soon
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  comingSoonTag: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 999,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  header: {
    alignItems: 'center',
    marginBottom: 16,
  },
  headerPill: {
    alignItems: 'center',
    backgroundColor: colors.gray900,
    borderRadius: 999,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  list: {
    gap: 16,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 24,
  },
  rowLabel: {
    flex: 1,
  },
  rowPressed: {
    opacity: 0.7,
  },
  sheet: {
    width: '100%',
  },
});
