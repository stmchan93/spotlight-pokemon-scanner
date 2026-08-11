import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Text, useSpotlightTheme } from '@spotlight/design-system';

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
  /**
   * How this sheet is presented.
   *
   * `modal` (default) wraps it in its own native `Modal`, which is what a screen
   * wants: the sheet has to sit above the whole app.
   *
   * `inline` renders exactly the same scrim + sheet as an absolutely-filled
   * overlay in the CALLER's view tree, with no `Modal` of its own. That is for a
   * caller that is ALREADY inside a `Modal` (the comments sheet): presenting a
   * second native modal over a presented one is unreliable on iOS — the comments
   * in this file and in `CardActionsSheet` are both scars from that collision —
   * and an in-tree overlay has no view controller to collide with. Callers using
   * `inline` are responsible for placing it last in their overlay's children so
   * it paints above the rest.
   */
  presentation?: 'modal' | 'inline';
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
  presentation = 'modal',
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

  const overlay = (
    <View
      pointerEvents={visible ? 'auto' : 'none'}
      style={presentation === 'inline' ? [styles.root, styles.inlineRoot] : styles.root}
    >
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
  );

  // In-tree: no `Modal`, so nothing to present and nothing to collide with.
  if (presentation === 'inline') {
    return overlay;
  }

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      // CONTROLLED, not hardcoded true: a bare `visible` kept the native modal
      // presented and unmounted it without a dismiss transition, so presenting
      // this sheet while the actions sheet was still tearing down collided at
      // the view-controller layer and FROZE the app. Driving it off the prop
      // lets the dismiss transition run cleanly.
      visible={visible}
    >
      {overlay}
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
  // `inline` only: fill the caller's Modal instead of being a Modal. `zIndex` so
  // the overlay paints above its siblings on both platforms rather than relying
  // on child order alone.
  inlineRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
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
