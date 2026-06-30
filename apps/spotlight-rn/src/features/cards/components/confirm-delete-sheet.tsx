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

type ConfirmDeleteSheetProps = {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Disables the destructive CTA while the delete request is in flight. */
  confirmPending?: boolean;
  /** Centered title — defaults to "Confirm Delete". */
  title?: string;
  /** Body copy explaining the consequence of the delete. Overrides `quantity`. */
  message?: string;
  /**
   * Copies in the entry being deleted. Deleting removes the WHOLE entry (all
   * copies), so when >1 the default copy says "all N copies" instead of "1 item".
   * Ignored when an explicit `message` is passed (e.g. portfolio bulk delete).
   */
  quantity?: number;
  /** Destructive CTA label — defaults to "Delete". */
  confirmLabel?: string;
  cancelLabel?: string;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

const MESSAGE_TAIL =
  "This can't be undone, and your Portfolio value and Insights will be recalculated.";

// Deleting removes the whole entry, so the copy must reflect ALL copies in it —
// not a hardcoded "1 item" (the bug: a qty-2 card said "delete 1").
function defaultDeleteMessage(quantity: number): string {
  if (quantity > 1) {
    return `You're about to delete all ${quantity} copies of this card from your Collection. ${MESSAGE_TAIL}`;
  }
  return `You're about to delete 1 item from your Collection. ${MESSAGE_TAIL}`;
}

/**
 * Destructive confirmation bottom sheet (Figma 1874:23342 "Delete from PDP"):
 * a handle + centered title + body, then a red Delete CTA over an outline Cancel.
 * Mirrors AddToCollectionSheet's pop-open slide and scrim so the two sheets feel
 * like one system; the header (handle + title) is the drag-to-dismiss zone.
 */
export function ConfirmDeleteSheet({
  visible,
  onClose,
  onConfirm,
  confirmPending = false,
  title = 'Confirm Delete',
  message,
  quantity = 1,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  testID = 'confirm-delete-sheet',
}: ConfirmDeleteSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const resolvedMessage = message ?? defaultDeleteMessage(quantity);

  // Keep mounted through the closing slide-down, then unmount (matches the add
  // sheet so the transition reads identically).
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

  // Drag-to-dismiss on the header (handle + title): PanResponder runs on the JS
  // thread, so these writes are safe (no gesture-handler worklet hazard).
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
      visible
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
              {title}
            </Text>
          </View>

          <Text style={[theme.typography.body, styles.message, { color: theme.colors.gray900 }]}>
            {resolvedMessage}
          </Text>

          <View style={styles.actions}>
            <Button
              disabled={confirmPending}
              label={confirmLabel}
              labelStyleVariant="label"
              onPress={onConfirm}
              shape="rounded"
              size="md"
              testID={`${testID}-confirm`}
              variant="destructive"
            />
            <Button
              disabled={confirmPending}
              label={cancelLabel}
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
    paddingTop: 24,
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
  message: {
    paddingHorizontal: 16,
    paddingTop: 16,
    textAlign: 'center',
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
  title: {
    paddingTop: 14,
    textAlign: 'center',
  },
});

export default ConfirmDeleteSheet;
