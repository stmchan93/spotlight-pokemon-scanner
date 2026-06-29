import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GridPlus, Heart, Trash } from 'iconoir-react-native';

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
// Gap between the bottom of the trigger and the top of the popped card.
const ANCHOR_GAP = 4;
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

  // Pop below the trigger and clamp inside the screen. `left` shifts in (never
  // negative) when the card would overflow the right edge; `top` falls back to
  // a sensible header position until the anchor has been measured.
  const screen = Dimensions.get('window');
  const top = anchor ? anchor.y + anchor.height + ANCHOR_GAP : FALLBACK_TOP;
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
            borderRadius: theme.radii.md,
            left,
            top,
          },
        ]}
        testID={testID}
      >
        <Pressable
          accessibilityLabel="Add all to collection"
          accessibilityRole="button"
          onPress={() => onSelect('collection')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-collection`}
        >
          <GridPlus color={theme.colors.gray900} height={18} width={18} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}>
            Collection
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Add all to wishlist"
          accessibilityRole="button"
          onPress={() => onSelect('wishlist')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-wishlist`}
        >
          <Heart color={theme.colors.gray900} height={18} width={18} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}>
            Wishlist
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Remove all"
          accessibilityRole="button"
          onPress={() => onSelect('remove')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          testID={`${testID}-remove`}
        >
          <Trash color={theme.colors.dangerStrong} height={18} width={18} />
          <Text style={[theme.typography.body, styles.label, { color: theme.colors.dangerStrong }]}>
            Remove
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
