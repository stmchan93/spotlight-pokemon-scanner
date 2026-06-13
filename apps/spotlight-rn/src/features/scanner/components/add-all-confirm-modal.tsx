import { GridPlus } from 'iconoir-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, useSpotlightTheme } from '@spotlight/design-system';

type AddAllConfirmModalProps = {
  visible: boolean;
  /** Number of scans that will be added — drives the subtitle copy. */
  itemCount: number;
  /** While true the buttons are disabled and the primary reads "Adding…". */
  isSubmitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
};

/**
 * Centered "Add all to collection?" confirmation dialog (Figma 1365:2276). Built
 * from the shared design-system `Button` (accent = purple primary, outline =
 * secondary) and tokens — no ad-hoc styling.
 */
export function AddAllConfirmModal({
  visible,
  itemCount,
  isSubmitting = false,
  onConfirm,
  onCancel,
  testID = 'scanner-add-all-modal',
}: AddAllConfirmModalProps) {
  const theme = useSpotlightTheme();
  const itemNoun = itemCount === 1 ? 'item' : 'items';

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="fade"
      onRequestClose={isSubmitting ? undefined : onCancel}
      transparent
      visible
    >
      <View style={styles.scrim}>
        {/* Tap outside the card to cancel (disabled mid-submit). */}
        <Pressable
          accessibilityLabel="Dismiss add all"
          disabled={isSubmitting}
          onPress={onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[styles.card, { backgroundColor: theme.colors.gray0, borderRadius: theme.radii.lg }]}
          testID={testID}
        >
          <View style={styles.topGroup}>
            <View style={[styles.iconCircle, { backgroundColor: theme.colors.gray100 }]}>
              <GridPlus color={theme.colors.gray900} height={24} width={24} />
            </View>
            <Text style={theme.typography.titleMedium}>Add all to collection?</Text>
            <Text
              style={[theme.typography.bodyMedium, styles.subtitle, { color: theme.colors.textMuted }]}
              testID={`${testID}-subtitle`}
            >
              {`${itemCount} ${itemNoun} will be added to your collection.`}
            </Text>
          </View>

          <View style={styles.buttonGroup}>
            <Button
              disabled={isSubmitting}
              label={isSubmitting ? 'Adding…' : 'Add All'}
              labelStyleVariant="label"
              onPress={onConfirm}
              shape="rounded"
              size="sm"
              style={styles.fullWidth}
              testID="scanner-add-all-confirm"
              variant="accent"
            />
            <Button
              disabled={isSubmitting}
              label="Cancel"
              labelStyleVariant="label"
              onPress={onCancel}
              shape="rounded"
              size="sm"
              style={styles.fullWidth}
              testID="scanner-add-all-cancel"
              variant="outline"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  buttonGroup: {
    gap: 12,
    width: '100%',
  },
  card: {
    alignItems: 'center',
    gap: 28,
    maxWidth: 329,
    padding: 20,
    width: '100%',
  },
  fullWidth: {
    width: '100%',
  },
  iconCircle: {
    alignItems: 'center',
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  scrim: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  subtitle: {
    textAlign: 'center',
  },
  topGroup: {
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
});

export default AddAllConfirmModal;
