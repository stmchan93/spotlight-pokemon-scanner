import { Dimensions, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { GridPlus, Trash } from 'iconoir-react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

export type InventoryEntryMenuAnchor = { x: number; y: number; width: number; height: number };

type InventoryEntryMenuProps = {
  visible: boolean;
  /** Measured screen coords of the "..." trigger (measureInWindow); null → fallback. */
  anchor: InventoryEntryMenuAnchor | null;
  /** "Add another" — opens the full Add-to-Collection sheet. */
  onAdd: () => void;
  /** "Delete this entry" — opens the destructive confirm. */
  onDelete: () => void;
  onClose: () => void;
  testID?: string;
};

const CARD_WIDTH = 200;
const SCREEN_MARGIN = 8;
const ANCHOR_GAP = 4;
const ESTIMATED_CARD_HEIGHT = 104;
const FALLBACK_TOP = 200;
const FALLBACK_LEFT = 16;

/**
 * Anchored glass dropdown for an inventory row's "..." — mirrors the scanner
 * tray's "Add All" menu (add-all-menu.tsx): a small rounded glass card that pops
 * next to the trigger with stacked rows. "Add another" opens the full
 * Add-to-Collection sheet; "Delete this entry" opens the destructive confirm.
 * Selecting a row only reports the action; the parent closes this + opens the
 * matching sheet.
 */
export function InventoryEntryMenu({
  visible,
  anchor,
  onAdd,
  onDelete,
  onClose,
  testID = 'inventory-entry-menu',
}: InventoryEntryMenuProps) {
  const theme = useSpotlightTheme();

  if (!visible) {
    return null;
  }

  // Pop next to the trigger, clamped inside the screen; flip ABOVE when there
  // isn't room below (bottom-anchored so it grows up regardless of real height).
  const screen = Dimensions.get('window');
  const anchorTop = anchor ? anchor.y : FALLBACK_TOP;
  const anchorBottom = anchor ? anchor.y + anchor.height : FALLBACK_TOP;
  const openUp =
    anchor != null
    && anchorBottom + ANCHOR_GAP + ESTIMATED_CARD_HEIGHT + SCREEN_MARGIN > screen.height;
  const verticalStyle = openUp
    ? { bottom: screen.height - anchorTop + ANCHOR_GAP }
    : { top: anchorBottom + ANCHOR_GAP };
  // Right-align the card to the trigger (the "..." sits at the row's right edge).
  const maxLeft = screen.width - CARD_WIDTH - SCREEN_MARGIN;
  const rawLeft = anchor ? anchor.x + anchor.width - CARD_WIDTH : FALLBACK_LEFT;
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
        {/* iOS ONLY. Android's dimezis blur samples the app's own view
            hierarchy, and inside a transparent Modal — a separate window —
            there is nothing to sample, so the "glass" was just the translucent
            fill with the screen showing through. Android gets an opaque card. */}
        {Platform.OS === 'ios' ? (
          <BlurView intensity={40} style={StyleSheet.absoluteFill} tint="light" />
        ) : null}
        <View
          style={[
            StyleSheet.absoluteFill,
            Platform.OS === 'ios' ? styles.glassFill : styles.opaqueFill,
          ]}
        />

        <Pressable
          accessibilityLabel="Add another to Collection"
          accessibilityRole="button"
          onPress={onAdd}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? 'rgba(0, 0, 0, 0.06)' : 'transparent' },
          ]}
          testID={`${testID}-add`}
        >
          <GridPlus color={theme.colors.gray900} height={20} width={20} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}>
            Add another
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Delete this entry"
          accessibilityRole="button"
          onPress={onDelete}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? 'rgba(0, 0, 0, 0.06)' : 'transparent' },
          ]}
          testID={`${testID}-delete`}
        >
          <Trash color={theme.colors.deltaDownText} height={20} width={20} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.deltaDownText }]}>
            Delete
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const CARD_RADIUS = 24;

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    borderRadius: CARD_RADIUS,
    minWidth: CARD_WIDTH,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 12,
    position: 'absolute',
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 40,
  },
  glassFill: {
    backgroundColor: 'rgba(245, 245, 245, 0.72)',
  },
  // Android: same gray, full opacity — no blur behind it (see the render note).
  opaqueFill: {
    backgroundColor: '#F5F5F5',
  },
  row: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    height: 40,
    paddingHorizontal: 14,
  },
  label: {
    marginLeft: 12,
  },
});

export default InventoryEntryMenu;
