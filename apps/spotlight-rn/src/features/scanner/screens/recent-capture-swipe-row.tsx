import { BlurView } from 'expo-blur';
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { IconMinus } from '@tabler/icons-react-native';
import { AccessibilityInfo, Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  LinearTransition,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
} from 'react-native-reanimated';

import { textStyles } from '@spotlight/design-system';

import { HeartToggle } from '@/components/heart-toggle';
import {
  recentCaptureActionRailRevealWidth,
  recentCaptureDeleteRevealWidth,
  recentCaptureFavoriteRevealWidth,
} from '@/features/scanner/recent-capture-swipe';

const favoriteHeartColor = '#E83E8C';
const captureRowHeight = 102;
// Release distance (from rest) at which the rail snaps open instead of closing.
// Kept small so a short, easy drag reliably reveals Favorite/Delete.
const railOpenThreshold = 36;

// Card-dismiss / advance choreography (design handoff "Exact spec" table).
// Exit: translateX 0 → -100% + opacity 1 → 0 over 290ms ease-in (slow-start,
// accelerates out). Enter: the advanced row slides in from the right,
// translateX 24 → 0 + opacity 0 → 1 over 400ms decelerate (no overshoot).
const ROW_EXIT_DURATION_MS = 290;
const ROW_ENTER_DURATION_MS = 400;
const ROW_ENTER_OFFSET_PX = 24;
const ROW_LAYOUT_DURATION_MS = 290;

// Custom reanimated exiting animation: slide the whole row left off its own
// width and fade. `-100%` in the web reference maps to the row's measured width.
function buildRowExitAnimation(values: ExitAnimationsValues) {
  'worklet';
  const width = values.currentWidth || Dimensions.get('window').width;
  return {
    initialValues: {
      opacity: 1,
      transform: [{ translateX: 0 }],
    },
    animations: {
      opacity: withTiming(0, { duration: ROW_EXIT_DURATION_MS, easing: Easing.in(Easing.ease) }),
      transform: [
        {
          translateX: withTiming(-width, {
            duration: ROW_EXIT_DURATION_MS,
            easing: Easing.in(Easing.ease),
          }),
        },
      ],
    },
  };
}

// Custom reanimated entering animation: slide in from +24px on the right and
// fade up. Decelerate curve, no overshoot.
function buildRowEnterAnimation(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: {
      opacity: 0,
      transform: [{ translateX: ROW_ENTER_OFFSET_PX }],
    },
    animations: {
      opacity: withTiming(1, {
        duration: ROW_ENTER_DURATION_MS,
        easing: Easing.bezier(0.2, 0.9, 0.1, 1),
      }),
      transform: [
        {
          translateX: withTiming(0, {
            duration: ROW_ENTER_DURATION_MS,
            easing: Easing.bezier(0.2, 0.9, 0.1, 1),
          }),
        },
      ],
    },
  };
}

const rowLayoutTransition = LinearTransition.duration(ROW_LAYOUT_DURATION_MS).easing(
  Easing.bezier(0.2, 0.9, 0.1, 1),
);

export type RecentCaptureSwipeRowProps = {
  actionRailKey: string;
  children: ReactNode;
  // When false, a newly-mounted row appears without the slide-in-from-right
  // enter animation. The collapsed tray sets this true so the next card
  // "advances" in after ADD; the expanded list sets it false so opening the
  // tray doesn't fan every row in at once.
  enableEnterAnimation?: boolean;
  onActionRailVisibilityChange?: (key: string, visible: boolean) => void;
  onDelete: (id: string) => void;
  onFavorite: (id: string) => void;
  isFavorite: boolean;
  testID: string;
};

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        /* default to motion-on if the query fails */
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return reduceMotion;
}

function RecentCaptureSwipeRowInner({
  actionRailKey,
  children,
  enableEnterAnimation = false,
  isFavorite,
  onActionRailVisibilityChange,
  onDelete,
  onFavorite,
  testID,
}: RecentCaptureSwipeRowProps) {
  const swipeableRef = useRef<Swipeable>(null);
  const reduceMotion = useReduceMotion();
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

  const handleFavorite = useCallback(() => {
    onFavorite(actionRailKey);
    setIsOpen(false);
    swipeableRef.current?.close();
  }, [actionRailKey, onFavorite]);

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
          accessibilityLabel={isFavorite ? 'Remove favorite' : 'Favorite recent scan'}
          accessibilityRole="button"
          accessibilityState={{ disabled: !isOpen }}
          importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'}
          onPress={isOpen ? handleFavorite : undefined}
          style={({ pressed }) => [
            styles.captureFavoriteButton,
            pressed ? styles.captureFavoriteButtonPressed : null,
          ]}
          testID={`${testID}-favorite-button`}
        >
          <BlurView intensity={20} pointerEvents="none" style={StyleSheet.absoluteFill} tint="dark" />
          <HeartToggle bounce="lively" burst fill={favoriteHeartColor} filled={isFavorite} size={16} />
          <Text style={styles.captureFavoriteLabel}>Favorite</Text>
        </Pressable>
        <Pressable
          accessibilityElementsHidden={!isOpen}
          accessibilityLabel="Delete recent scan"
          accessibilityRole="button"
          accessibilityState={{ disabled: !isOpen }}
          importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'}
          onPress={isOpen ? handleDelete : undefined}
          style={({ pressed }) => [
            styles.captureDeleteButton,
            pressed ? styles.captureDeleteButtonPressed : null,
          ]}
          testID={`${testID}-delete-button`}
        >
          <BlurView intensity={20} pointerEvents="none" style={StyleSheet.absoluteFill} tint="dark" />
          <IconMinus color="#FF453A" size={18} strokeWidth={2.4} />
          <Text style={styles.captureDeleteLabel}>Delete</Text>
        </Pressable>
      </Animated.View>
    );
  }, [handleDelete, handleFavorite, isFavorite, isOpen, testID]);

  useEffect(() => {
    return () => {
      onActionRailVisibilityChange?.(actionRailKey, false);
    };
  }, [actionRailKey, onActionRailVisibilityChange]);

  return (
    // Outer reanimated wrapper owns the card-dismiss choreography: a removed row
    // slides left + fades (exiting), a newly-revealed row slides in from the
    // right (entering), and surviving siblings glide into their new slot
    // (layout). Reduced-motion drops every animation so rows appear/leave
    // instantly. The Swipeable's own favorite/delete rail is untouched.
    <Reanimated.View
      entering={reduceMotion || !enableEnterAnimation ? undefined : buildRowEnterAnimation}
      exiting={reduceMotion ? undefined : buildRowExitAnimation}
      layout={reduceMotion ? undefined : rowLayoutTransition}
    >
    <Swipeable
      ref={swipeableRef}
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
    </Reanimated.View>
  );
}

export const RecentCaptureSwipeRow = memo(RecentCaptureSwipeRowInner);

const styles = StyleSheet.create({
  captureActionRail: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 6,
    paddingLeft: 6,
    width: recentCaptureActionRailRevealWidth,
  },
  captureDeleteButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    borderRadius: 18,
    gap: 6,
    justifyContent: 'center',
    minHeight: captureRowHeight,
    overflow: 'hidden',
    width: recentCaptureDeleteRevealWidth,
  },
  captureDeleteButtonPressed: {
    opacity: 0.82,
  },
  captureDeleteLabel: {
    ...textStyles.control,
    color: '#FF453A',
    fontSize: 10,
    lineHeight: 12,
    textAlign: 'center',
    textTransform: 'none',
  },
  captureFavoriteButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    borderRadius: 18,
    gap: 6,
    justifyContent: 'center',
    minHeight: captureRowHeight,
    overflow: 'hidden',
    width: recentCaptureFavoriteRevealWidth,
  },
  captureFavoriteButtonPressed: {
    opacity: 0.84,
  },
  captureFavoriteLabel: {
    ...textStyles.control,
    color: favoriteHeartColor,
    fontSize: 10,
    lineHeight: 12,
    textAlign: 'center',
    textTransform: 'none',
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
