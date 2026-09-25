import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GridPlus, Trash } from 'iconoir-react-native';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

import { Text, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import {
  recentCaptureActionCircleSize,
  recentCaptureActionGap,
  recentCaptureActionIconSize,
  recentCaptureActionRailPadding,
  recentCaptureActionRailRevealWidth,
} from '@/features/scanner/recent-capture-swipe';

const captureRowHeight = 102;
// Release distance (from rest) at which the rail snaps open instead of closing.
// Kept small so a short, easy drag reliably reveals Favorite/Delete.
const railOpenThreshold = 36;

// Enter/exit/glide choreography lives in scan-tray-list.tsx: the tray is a
// recycled list, so a row no longer owns its mount/unmount animations.
export type RecentCaptureSwipeRowProps = {
  actionRailKey: string;
  children: ReactNode;
  onActionRailVisibilityChange?: (key: string, visible: boolean) => void;
  onAddToCollection: (id: string) => void;
  onDelete: (id: string) => void;
  testID: string;
};

function RecentCaptureSwipeRowInner({
  actionRailKey,
  children,
  onActionRailVisibilityChange,
  onAddToCollection,
  onDelete,
  testID,
}: RecentCaptureSwipeRowProps) {
  const theme = useSpotlightTheme();
  const swipeableRef = useRef<Swipeable>(null);
  // Mirrors the Swipeable's open/closed state. The native gesture owns the
  // animation; we only track open-ness to gate the actions (so an off-screen
  // Delete can't be activated by a screen reader or stray tap) and to toggle the
  // tray's top-level swipe via onActionRailVisibilityChange.
  const [isOpen, setIsOpen] = useState(false);

  const handleWillOpen = useCallback(() => {
    setIsOpen(true);
    onActionRailVisibilityChange?.(actionRailKey, true);
  }, [actionRailKey, onActionRailVisibilityChange]);

  const handleWillClose = useCallback(() => {
    setIsOpen(false);
    onActionRailVisibilityChange?.(actionRailKey, false);
  }, [actionRailKey, onActionRailVisibilityChange]);

  const handleAddToCollection = useCallback(() => {
    // Add the scan to the collection (same flow as the row's ADD pill) and close
    // the rail — the row shows its "ADDED" confirmation and then advances out of
    // the tray, so leaving the rail open would just flash empty space.
    onAddToCollection(actionRailKey);
    swipeableRef.current?.close();
  }, [actionRailKey, onAddToCollection]);

  const handleDelete = useCallback(() => {
    onDelete(actionRailKey);
  }, [actionRailKey, onDelete]);

  const renderRightActions = useCallback((
    progress: Animated.AnimatedInterpolation<number>,
  ) => {
    // Slide the whole rail in from the right edge in lockstep with the swipe so
    // the buttons feel pushed out as the row opens (and pushed back in as it
    // closes) — instead of sitting static while the row uncovers/recovers them.
    const translateX = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [recentCaptureActionRailRevealWidth, 0],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View
        style={[styles.captureActionRail, { transform: [{ translateX }] }]}
        testID={`${testID}-actions-underlay`}
      >
        <Pressable
          accessibilityElementsHidden={!isOpen}
          accessibilityLabel="Add recent scan to collection"
          accessibilityRole="button"
          accessibilityState={{ disabled: !isOpen }}
          importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'}
          onPress={isOpen ? handleAddToCollection : undefined}
          style={({ pressed }) => [
            styles.captureActionGroup,
            pressed ? styles.captureActionGroupPressed : null,
          ]}
          testID={`${testID}-collection-button`}
        >
          <View style={[styles.captureActionCircle, { backgroundColor: theme.colors.yellow400 }]}>
            <GridPlus
              color={theme.colors.gray900}
              height={recentCaptureActionIconSize}
              width={recentCaptureActionIconSize}
            />
          </View>
          <Text style={[styles.captureActionLabel, { color: theme.colors.scannerTextPrimary }]}>
            Collection
          </Text>
        </Pressable>
        <Pressable
          accessibilityElementsHidden={!isOpen}
          accessibilityLabel="Delete recent scan"
          accessibilityRole="button"
          accessibilityState={{ disabled: !isOpen }}
          importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'}
          onPress={isOpen ? handleDelete : undefined}
          style={({ pressed }) => [
            styles.captureActionGroup,
            pressed ? styles.captureActionGroupPressed : null,
          ]}
          testID={`${testID}-delete-button`}
        >
          <View style={[styles.captureActionCircle, { backgroundColor: theme.colors.dangerStrong }]}>
            <Trash
              color={theme.colors.gray0}
              height={recentCaptureActionIconSize}
              width={recentCaptureActionIconSize}
            />
          </View>
          <Text style={[styles.captureActionLabel, { color: theme.colors.scannerTextPrimary }]}>
            Delete
          </Text>
        </Pressable>
      </Animated.View>
    );
  }, [handleAddToCollection, handleDelete, isOpen, testID, theme]);

  useEffect(() => {
    return () => {
      onActionRailVisibilityChange?.(actionRailKey, false);
    };
  }, [actionRailKey, onActionRailVisibilityChange]);

  // A recycled cell now shows another scan: close this one's rail instantly
  // (no animation) so the new row never appears half-swiped. The effect above
  // already reported the old key's rail as closed.
  const railKeyRef = useRef(actionRailKey);
  useLayoutEffect(() => {
    if (railKeyRef.current === actionRailKey) {
      return;
    }
    railKeyRef.current = actionRailKey;
    swipeableRef.current?.reset?.();
    setIsOpen(false);
  }, [actionRailKey]);

  return (
    <Swipeable
      ref={swipeableRef}
      // Scope the horizontal claim by rail state (same negotiation as the
      // Wishlist rows, ed01a2a). While the rail is CLOSED the row only claims
      // clear LEFTWARD drags — the reveal direction — so rightward pans fall
      // through to whoever owns them now: the pager's edge page-swipe back to
      // Collection, or the native stack back gesture that the pushed-scanner
      // route armed (Scan tab pushes /?page=scanner since 6d7879b). The legacy
      // Swipeable default ([-10, 10]) silently claimed BOTH directions, which
      // both ate those gestures over the tray and let rightward jitter at the
      // start of a reveal grab (and rubber-band) the row instead of opening the
      // rail. Once OPEN the row claims both directions again so a right-swipe
      // still closes it.
      activeOffsetX={isOpen ? [-10, 10] : -10}
      containerStyle={styles.captureSwipeShell}
      friction={1.6}
      onSwipeableWillClose={handleWillClose}
      onSwipeableWillOpen={handleWillOpen}
      overshootRight={false}
      renderRightActions={renderRightActions}
      rightThreshold={railOpenThreshold}
      testID={testID}
    >
      {/*
        jest can't drive the native swipe, so expose hidden controls that flip
        the same open/close state the real gesture would. No-ops outside tests.
      */}
      {process.env.NODE_ENV === 'test' ? (
        <>
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={handleWillOpen}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-reveal-actions`}
          />
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={handleWillClose}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-collapse-delete`}
          />
        </>
      ) : null}
      <View style={styles.captureSwipeContent}>{children}</View>
    </Swipeable>
  );
}

export const RecentCaptureSwipeRow = memo(RecentCaptureSwipeRowInner);

const styles = StyleSheet.create({
  // Right-aligned rail of circular actions, vertically centered against the row,
  // 16px between each group (Figma 1768:4056/4060).
  captureActionRail: {
    // Top-aligned, not centered: the chip+label group then ends level with the
    // row's ADD pill (its bottom ≈ the Collection label's bottom) and the chips
    // sit up by the tray header's TOTAL chip — the alignment ask on Figma
    // 1768-4056..4063.
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: recentCaptureActionGap,
    justifyContent: 'flex-end',
    minHeight: captureRowHeight,
    paddingHorizontal: recentCaptureActionRailPadding,
    width: recentCaptureActionRailRevealWidth,
  },
  // One action: a circular chip with the icon centered, label 4px underneath
  // (Figma 1768:4056/4060). Chip fills come inline from theme tokens —
  // yellow/400 for Collection, red/500 (dangerStrong) for the destructive
  // Delete.
  captureActionGroup: {
    alignItems: 'center',
    gap: 4,
  },
  captureActionGroupPressed: {
    opacity: 0.8,
  },
  // 42px circle (Figma radius 26.5 clamps to the half-size) with padding 4
  // around the 20px icon (Figma 1768:4057/4061).
  captureActionCircle: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: recentCaptureActionCircleSize / 2,
    height: recentCaptureActionCircleSize,
    justifyContent: 'center',
    padding: 4,
    width: recentCaptureActionCircleSize,
  },
  // "Overline" label per Figma — 11px Plus Jakarta Sans Medium, 1.3 line-height
  // (textStyles.overline); white via the scanner text token, applied inline.
  captureActionLabel: {
    ...textStyles.overline,
    textAlign: 'center',
  },
  captureSwipeContent: {
    width: '100%',
  },
  captureSwipeShell: {
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  captureSwipeTestControl: {
    height: 1,
    left: -1000,
    opacity: 0,
    position: 'absolute',
    top: -1000,
    width: 1,
  },
});
