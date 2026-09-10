import { Dimensions, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { IconCheck } from '@tabler/icons-react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

import {
  type BinderPageLayoutId,
  binderPageLayouts,
} from '@/features/scanner/scanner-normalized-target';

/** 'single' = one card at a time; otherwise a binder-page layout id. */
export type BinderLayoutMenuSelection = 'single' | BinderPageLayoutId;

type BinderLayoutMenuAnchor = { x: number; y: number; width: number; height: number };

type BinderLayoutMenuProps = {
  visible: boolean;
  /** Measured screen coords of the trigger pill (measureInWindow); null until measured. */
  anchor: BinderLayoutMenuAnchor | null;
  selected: BinderLayoutMenuSelection;
  onSelect: (selection: BinderLayoutMenuSelection) => void;
  onClose: () => void;
  testID?: string;
};

const CARD_WIDTH = 168;
const SCREEN_MARGIN = 8;
const ANCHOR_GAP = 4;
const ROW_HEIGHT = 40;
const FALLBACK_TOP = 96;
const FALLBACK_LEFT = 16;

/**
 * Scan-mode dropdown for the scanner's controls row: Single, then one row per
 * binder layout ("Multi-Scan", Figma 5085:15256 — what it does, never its
 * grid). Same anchored glass card as the tray's ADD ALL menu; pops UP because
 * the trigger sits just above the tray.
 */
export function BinderLayoutMenu({
  visible,
  anchor,
  selected,
  onSelect,
  onClose,
  testID = 'binder-layout-menu',
}: BinderLayoutMenuProps) {
  const theme = useSpotlightTheme();

  if (!visible) {
    return null;
  }

  const rows: Array<{ id: BinderLayoutMenuSelection; label: string }> = [
    { id: 'single', label: 'Single' },
    ...binderPageLayouts.map((layout) => ({ id: layout.id, label: layout.label })),
  ];
  const cardHeight = rows.length * ROW_HEIGHT + 28;

  const screen = Dimensions.get('window');
  const anchorTop = anchor ? anchor.y : FALLBACK_TOP;
  const anchorBottom = anchor ? anchor.y + anchor.height : FALLBACK_TOP;
  const openUp = anchor != null && anchorBottom + ANCHOR_GAP + cardHeight + SCREEN_MARGIN > screen.height;
  const verticalStyle = openUp
    ? { bottom: screen.height - anchorTop + ANCHOR_GAP }
    : { top: anchorBottom + ANCHOR_GAP };
  const maxLeft = screen.width - CARD_WIDTH - SCREEN_MARGIN;
  const rawLeft = anchor ? anchor.x : FALLBACK_LEFT;
  const left = Math.max(SCREEN_MARGIN, Math.min(rawLeft, maxLeft));

  return (
    <Modal animationType="none" onRequestClose={onClose} transparent visible>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID={`${testID}-backdrop`}
      />
      <View style={[styles.card, { left, ...verticalStyle }]} testID={testID}>
        {/* iOS-only blur: inside a transparent Modal Android has nothing to sample. */}
        {Platform.OS === 'ios' ? (
          <BlurView intensity={40} style={StyleSheet.absoluteFill} tint="light" />
        ) : null}
        <View
          style={[
            StyleSheet.absoluteFill,
            Platform.OS === 'ios' ? styles.glassFill : styles.opaqueFill,
          ]}
        />
        {rows.map((row) => {
          const isSelected = row.id === selected;
          return (
            <Pressable
              accessibilityLabel={row.id === 'single' ? 'Scan one card at a time' : `${row.label}: scan a whole binder page at once`}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              key={row.id}
              onPress={() => onSelect(row.id)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? 'rgba(0, 0, 0, 0.06)' : 'transparent' },
              ]}
              testID={`${testID}-${row.id}`}
            >
              <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}>
                {row.label}
              </Text>
              {isSelected ? (
                <IconCheck color={theme.colors.gray900} size={18} strokeWidth={2.2} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

const CARD_RADIUS = 34;

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    borderCurve: 'continuous',
    borderRadius: CARD_RADIUS,
    elevation: 8,
    minWidth: CARD_WIDTH,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 14,
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 40,
  },
  glassFill: {
    backgroundColor: 'rgba(245, 245, 245, 0.6)',
  },
  opaqueFill: {
    backgroundColor: '#F5F5F5',
  },
  row: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    flexDirection: 'row',
    height: ROW_HEIGHT,
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  label: {
    marginRight: 12,
  },
});

export default BinderLayoutMenu;
