import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, useSpotlightTheme } from '@spotlight/design-system';

type InventoryEntryActionsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Opens the same Add-to-Collection sheet used elsewhere on the PDP. */
  onAdd: () => void;
  /** Opens the destructive delete-confirm for the tapped entry. */
  onDelete: () => void;
  /** Small subtitle line for context, e.g. "PSA 10 · Holofoil". */
  entryLabel?: string | null;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * Per-entry actions bottom sheet for an inventory row's "..." control: "Add
 * another to Collection" (reuses the Add-to-Collection sheet) over a destructive
 * "Delete this entry". Mirrors ConfirmDeleteSheet's slide/scrim so the sheets
 * feel like one system. Callers close THIS sheet before opening the add/delete
 * sheet (a short defer) so the two Modals never present/tear-down at once.
 */
export function InventoryEntryActionsSheet({
  visible,
  onClose,
  onAdd,
  onDelete,
  entryLabel,
  testID = 'inventory-entry-actions-sheet',
}: InventoryEntryActionsSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [translateY, visible]);

  const dragResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 80 || gesture.vy > 0.5) {
            onClose();
            return;
          }
          Animated.spring(translateY, {
            toValue: 0,
            damping: 34,
            mass: 1,
            stiffness: 320,
            useNativeDriver: false,
          }).start();
        },
      }),
    [onClose, translateY],
  );

  if (!isRendered) {
    return null;
  }

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View pointerEvents={visible ? 'auto' : 'none'} style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.gray0,
              paddingBottom: Math.max(insets.bottom, 16) + 8,
              transform: [{ translateY }],
            },
          ]}
          testID={testID}
        >
          <View style={styles.header} {...dragResponder.panHandlers}>
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              hitSlop={16}
              onPress={onClose}
              style={styles.handleHit}
              testID={`${testID}-handle`}
            >
              <View style={[styles.handleBar, { backgroundColor: theme.colors.gray200 }]} />
            </Pressable>
            <Text
              style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray900 }]}
            >
              Inventory item
            </Text>
            {entryLabel ? (
              <Text style={[theme.typography.label, styles.subtitle, { color: theme.colors.gray500 }]}>
                {entryLabel}
              </Text>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Button
              label="Add another to Collection"
              labelStyleVariant="label"
              onPress={onAdd}
              shape="rounded"
              size="md"
              testID={`${testID}-add`}
              variant="dark"
            />
            <Button
              label="Delete this entry"
              labelStyleVariant="label"
              onPress={onDelete}
              shape="rounded"
              size="md"
              testID={`${testID}-delete`}
              variant="destructive"
            />
            <Button
              label="Cancel"
              labelStyleVariant="label"
              onPress={onClose}
              shape="rounded"
              size="md"
              testID={`${testID}-cancel`}
              variant="outline"
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  handleBar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  header: {
    width: '100%',
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingTop: 10,
  },
  subtitle: {
    paddingTop: 4,
    textAlign: 'center',
  },
  title: {
    paddingTop: 14,
    textAlign: 'center',
  },
});

export default InventoryEntryActionsSheet;
