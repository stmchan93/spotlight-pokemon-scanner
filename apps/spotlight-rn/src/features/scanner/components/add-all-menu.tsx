import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GridPlus, Bookmark, Trash } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

export type AddAllMenuAction = 'collection' | 'wishlist' | 'remove';

type AddAllMenuAnchor = { x: number; y: number; width: number; height: number };

type AddAllMenuProps = {
  visible: boolean;
  /** Measured screen coords of the trigger (measureInWindow); null until measured. */
  anchor: AddAllMenuAnchor | null;
  onSelect: (action: AddAllMenuAction) => void;
  onClose: () => void;
  testID?: string;
};

const CARD_WIDTH = 180;
// Inset the card from the screen edges so the shadow never clips off-screen.
const SCREEN_MARGIN = 8;
// Gap between the trigger and the popped card.
const ANCHOR_GAP = 4;
// Rough height of the 3-row card (rows ~40px + 12px vertical padding). Only used
// to decide whether to flip the menu up; the upward position is bottom-anchored,
// so it stays exact even if the real height differs.
const ESTIMATED_CARD_HEIGHT = 140;
// Fallback origin when we have no measured anchor yet (top-left under a header).
const FALLBACK_TOP = 96;
const FALLBACK_LEFT = 16;

/**
 * Anchored dropdown for the scanner tray's "ADD ALL ▾" control — Figma
 * 1379:2323 (second frame). A small white rounded card pops just below the
 * header trigger over the dark tray and lists three stacked rows: Collection,
 * Wishlist, and a destructive-red Remove. Selecting a row only reports the
 * action; the parent closes this menu and opens the matching confirm sheet.
 */
export function AddAllMenu({
  visible,
  anchor,
  onSelect,
  onClose,
  testID = 'add-all-menu',
}: AddAllMenuProps) {
  const theme = useSpotlightTheme();

  if (!visible) {
    return null;
  }

  // Pop next to the trigger and clamp inside the screen. `left` shifts in (never
  // negative) when the card would overflow the right edge. By default the card
  // drops BELOW the trigger; when there isn't room below it (the scan tray's
  // ADD ▾ sits near the bottom edge) it flips ABOVE instead so the rows don't
  // clip off-screen. The upward case anchors the card's BOTTOM just above the
  // trigger via `bottom`, so it grows up regardless of its measured height.
  const screen = Dimensions.get('window');
  const anchorTop = anchor ? anchor.y : FALLBACK_TOP;
  const anchorBottom = anchor ? anchor.y + anchor.height : FALLBACK_TOP;
  const openUp = anchor != null
    && anchorBottom + ANCHOR_GAP + ESTIMATED_CARD_HEIGHT + SCREEN_MARGIN > screen.height;
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
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.gray0,
            borderRadius: theme.radii.xl,
            left,
            ...verticalStyle,
          },
        ]}
        testID={testID}
      >
        <Pressable
          accessibilityLabel="Add to collection"
          accessibilityRole="button"
          onPress={() => onSelect('collection')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-collection`}
        >
          <GridPlus color={theme.colors.gray900} height={20} width={20} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}>
            Collection
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Add to wishlist"
          accessibilityRole="button"
          onPress={() => onSelect('wishlist')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-wishlist`}
        >
          <Bookmark color={theme.colors.gray900} height={20} width={20} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}>
            Wishlist
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Delete"
          accessibilityRole="button"
          onPress={() => onSelect('remove')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-remove`}
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

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    minWidth: CARD_WIDTH,
    paddingVertical: 6,
    position: 'absolute',
    // Subtle floating-menu shadow over the dark tray.
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  label: {
    marginLeft: 12,
  },
});

export default AddAllMenu;
