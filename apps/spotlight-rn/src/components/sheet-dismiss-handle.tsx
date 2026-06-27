import { useMemo } from 'react';
import { PanResponder, Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@spotlight/design-system';

type SheetDismissHandleProps = {
  /** Dismiss the host sheet — fired on a tap or a deliberate downward swipe. */
  onDismiss: () => void;
  /** Grab-bar color. Defaults to the light-sheet gray-200 bar. */
  barColor?: string;
  testID?: string;
};

/**
 * The grab handle at the top of a bottom sheet. Dismisses on TAP or a downward
 * SWIPE that starts on the handle — not just a backdrop tap. PanResponder only
 * claims the gesture on a deliberate downward drag, so a stationary tap still
 * fires the Pressable's onPress. Mirrors the scanner "Scanning for" sheet so the
 * dismiss gesture feels identical across the app.
 */
export function SheetDismissHandle({
  onDismiss,
  barColor = colors.gray200,
  testID,
}: SheetDismissHandleProps) {
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 24 || gesture.vy > 0.5) {
            onDismiss();
          }
        },
      }),
    [onDismiss],
  );

  return (
    <Pressable
      accessibilityLabel="Close"
      accessibilityRole="button"
      hitSlop={16}
      onPress={onDismiss}
      style={styles.hitArea}
      testID={testID}
      {...panResponder.panHandlers}
    >
      <View style={[styles.bar, { backgroundColor: barColor }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  hitArea: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
});

export default SheetDismissHandle;
