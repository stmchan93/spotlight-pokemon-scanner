import { BlurView } from 'expo-blur';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconHeart,
  IconHeartFilled,
  IconMinus,
} from '@tabler/icons-react-native';
import {
  Animated,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { textStyles } from '@spotlight/design-system';

import {
  clampRecentCaptureSwipeTranslate,
  recentCaptureActionRailRevealWidth,
  recentCaptureDeleteRevealWidth,
  recentCaptureFavoriteRevealWidth,
  shouldCollapseRecentCaptureDeleteFromSwipe,
  shouldRevealRecentCaptureDeleteFromSwipe,
  shouldSetRecentCaptureSwipeResponder,
} from '@/features/scanner/recent-capture-swipe';

const favoriteHeartColor = '#E83E8C';
const captureRowHeight = 102;

export type RecentCaptureSwipeRowProps = {
  actionRailKey: string;
  children: ReactNode;
  onActionRailVisibilityChange?: (key: string, visible: boolean) => void;
  onDelete: () => void;
  onFavorite: () => void;
  isFavorite: boolean;
  testID: string;
};

export function RecentCaptureSwipeRow({
  actionRailKey,
  children,
  isFavorite,
  onActionRailVisibilityChange,
  onDelete,
  onFavorite,
  testID,
}: RecentCaptureSwipeRowProps) {
  const [isActionRailRevealed, setIsActionRailRevealed] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;
  const deleteOpacity = useMemo(() => translateX.interpolate({
    extrapolate: 'clamp',
    inputRange: [-recentCaptureActionRailRevealWidth, 0],
    outputRange: [1, 0],
  }), [translateX]);

  const settleClosed = useCallback(() => {
    setIsActionRailRevealed(false);
    onActionRailVisibilityChange?.(actionRailKey, false);
    Animated.spring(translateX, {
      bounciness: 0,
      speed: 16,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [actionRailKey, onActionRailVisibilityChange, translateX]);

  const revealActionRail = useCallback(() => {
    setIsActionRailRevealed(true);
    onActionRailVisibilityChange?.(actionRailKey, true);
    Animated.spring(translateX, {
      bounciness: 0,
      speed: 18,
      toValue: -recentCaptureActionRailRevealWidth,
      useNativeDriver: true,
    }).start();
  }, [actionRailKey, onActionRailVisibilityChange, translateX]);

  const handleSwipeMove = useCallback((gestureState: PanResponderGestureState) => {
    translateX.setValue(clampRecentCaptureSwipeTranslate(gestureState.dx, isActionRailRevealed));
  }, [isActionRailRevealed, translateX]);

  const handleSwipeEnd = useCallback((gestureState: PanResponderGestureState) => {
    if (isActionRailRevealed) {
      if (shouldCollapseRecentCaptureDeleteFromSwipe(gestureState)) {
        settleClosed();
        return;
      }

      revealActionRail();
      return;
    }

    if (shouldRevealRecentCaptureDeleteFromSwipe(gestureState)) {
      revealActionRail();
      return;
    }

    settleClosed();
  }, [isActionRailRevealed, revealActionRail, settleClosed]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => shouldSetRecentCaptureSwipeResponder(gestureState, isActionRailRevealed),
    onPanResponderMove: (_, gestureState) => handleSwipeMove(gestureState),
    onPanResponderRelease: (_, gestureState) => handleSwipeEnd(gestureState),
    onPanResponderTerminate: () => {
      settleClosed();
    },
  }), [handleSwipeEnd, handleSwipeMove, isActionRailRevealed, settleClosed]);

  useEffect(() => {
    return () => {
      onActionRailVisibilityChange?.(actionRailKey, false);
    };
  }, [actionRailKey, onActionRailVisibilityChange]);

  return (
    <View
      style={styles.captureSwipeShell}
      testID={testID}
      {...panResponder.panHandlers}
    >
      {process.env.NODE_ENV === 'test' ? (
        <>
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={revealActionRail}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-reveal-actions`}
          />
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={settleClosed}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-collapse-delete`}
          />
        </>
      ) : null}
      <Animated.View
        pointerEvents={isActionRailRevealed ? 'auto' : 'none'}
        style={[styles.captureDeleteUnderlay, { opacity: deleteOpacity }]}
        testID={`${testID}-actions-underlay`}
      >
        <View style={styles.captureActionRail}>
          <Pressable
            accessibilityElementsHidden={!isActionRailRevealed}
            accessibilityLabel={isFavorite ? 'Remove favorite' : 'Favorite recent scan'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !isActionRailRevealed }}
            importantForAccessibility={isActionRailRevealed ? 'auto' : 'no-hide-descendants'}
            onPress={isActionRailRevealed
              ? () => {
                  onFavorite();
                  settleClosed();
                }
              : undefined}
            style={({ pressed }) => [
              styles.captureFavoriteButton,
              pressed ? styles.captureFavoriteButtonPressed : null,
            ]}
            testID={`${testID}-favorite-button`}
          >
            <BlurView intensity={20} pointerEvents="none" style={StyleSheet.absoluteFill} tint="dark" />
            {isFavorite ? (
              <IconHeartFilled color={favoriteHeartColor} size={16} />
            ) : (
              <IconHeart color={favoriteHeartColor} size={16} strokeWidth={2} />
            )}
            <Text style={styles.captureFavoriteLabel}>Favorite</Text>
          </Pressable>
          <Pressable
            accessibilityElementsHidden={!isActionRailRevealed}
            accessibilityLabel="Delete recent scan"
            accessibilityRole="button"
            accessibilityState={{ disabled: !isActionRailRevealed }}
            importantForAccessibility={isActionRailRevealed ? 'auto' : 'no-hide-descendants'}
            onPress={isActionRailRevealed ? onDelete : undefined}
            style={({ pressed }) => [
              styles.captureDeleteButton,
              pressed ? styles.captureDeleteUnderlayPressed : null,
            ]}
            testID={`${testID}-delete-button`}
          >
            <BlurView intensity={20} pointerEvents="none" style={StyleSheet.absoluteFill} tint="dark" />
            <IconMinus color="#FF453A" size={18} strokeWidth={2.4} />
            <Text style={styles.captureDeleteLabel}>Delete</Text>
          </Pressable>
        </View>
      </Animated.View>
      <Animated.View style={[styles.captureSwipeContent, { transform: [{ translateX }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

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
  captureDeleteLabel: {
    ...textStyles.control,
    color: '#FF453A',
    fontSize: 10,
    lineHeight: 12,
    textAlign: 'center',
    textTransform: 'none',
  },
  captureDeleteUnderlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: recentCaptureActionRailRevealWidth,
  },
  captureDeleteUnderlayPressed: {
    opacity: 0.82,
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
