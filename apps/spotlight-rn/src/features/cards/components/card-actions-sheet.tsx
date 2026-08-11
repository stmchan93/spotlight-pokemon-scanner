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
import { EditPencil, Heart, ShareIos, Trash } from 'iconoir-react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

type CardActionsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Fires after the native modal view controller has fully dismissed (iOS). Use
   * this to present a follow-up native sheet (e.g. the Share sheet) safely —
   * presenting while this modal is still dismissing freezes the screen.
   */
  onDismiss?: () => void;
  /** Card name shown as the centered title. */
  title: string;
  onEdit: () => void;
  onShare: () => void;
  onWishlist: () => void;
  onDelete: () => void;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * Long-press context menu for a Collection card (Figma 1696:8708): a bottom
 * sheet titled with the card name, listing Edit / Share / Wishlist / Delete
 * (Delete in red). Mirrors ConfirmDeleteSheet's pop-open slide + scrim +
 * drag-to-dismiss so the two read as one system.
 *
 * Duplicate was removed by request: silently minting a second copy of a card
 * from a long-press was more often an accident than an intent, and the Edit
 * sheet already owns quantity.
 */
export function CardActionsSheet({
  visible,
  onClose,
  onDismiss,
  title,
  onEdit,
  onShare,
  onWishlist,
  onDelete,
  testID = 'card-actions-sheet',
}: CardActionsSheetProps) {
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

  const actions = useMemo(
    () => [
      { key: 'edit', label: 'Edit', Icon: EditPencil, onPress: onEdit, destructive: false },
      { key: 'share', label: 'Share', Icon: ShareIos, onPress: onShare, destructive: false },
      { key: 'wishlist', label: 'Wishlist', Icon: Heart, onPress: onWishlist, destructive: false },
      { key: 'delete', label: 'Delete', Icon: Trash, onPress: onDelete, destructive: true },
    ],
    [onDelete, onEdit, onShare, onWishlist],
  );

  if (!isRendered) {
    return null;
  }

  return (
    <Modal
      animationType="none"
      onDismiss={onDismiss}
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      // CONTROLLED, not hardcoded true: a bare `visible` kept the native modal
      // presented and unmounted it without a dismiss transition, so `onDismiss`
      // never fired (dead Share) and presenting a follow-up modal (Confirm
      // Delete) collided with the still-live view controller and FROZE the app.
      // Driving it off the prop makes the dismiss + onDismiss fire reliably.
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
              numberOfLines={1}
              style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray900 }]}
            >
              {title}
            </Text>
          </View>

          <View style={styles.list}>
            {actions.map(({ key, label, Icon, onPress, destructive }) => {
              const color = destructive ? theme.colors.deltaDownText : theme.colors.gray900;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={key}
                  onPress={onPress}
                  style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
                  testID={`${testID}-${key}`}
                >
                  <Icon color={color} height={20} width={20} />
                  <Text style={[theme.typography.body, { color }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  list: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    height: 40,
  },
  sheet: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingTop: 10,
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 4,
    textAlign: 'center',
  },
});

export default CardActionsSheet;
