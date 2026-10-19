import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

import { radii, useSpotlightTheme } from '@spotlight/design-system';

type InsightsBottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Rendered under the grab handle, inside the drag-to-dismiss zone (title
   * row, header actions). Children render below it, outside that zone.
   */
  header?: ReactNode;
  children: ReactNode;
  testID: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * The Insights page's sheet shell: scrim, spring-up / ease-down slide, grab
 * handle, and a drag-to-dismiss header zone. Mirrors ConfirmDeleteSheet so the
 * app's sheets feel like one system. The "Filter By" sort sheet and the game
 * picker both sit on this; they only differ in header and rows.
 */
export function InsightsBottomSheet({
  visible,
  onClose,
  header,
  children,
  testID,
}: InsightsBottomSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Keep mounted through the closing slide-down, then unmount (matches the
  // delete/add sheets so the transition reads identically).
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
            {header}
          </View>
          {children}
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
    borderCurve: 'continuous',
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
  },
  header: {
    width: '100%',
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderCurve: 'continuous',
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    overflow: 'hidden',
    paddingTop: 10,
  },
});

export default InsightsBottomSheet;
