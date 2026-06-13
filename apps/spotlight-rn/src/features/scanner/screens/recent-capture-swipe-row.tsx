import { BlurView } from 'expo-blur';
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  IconHeart,
  IconHeartFilled,
  IconMinus,
} from '@tabler/icons-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

import { textStyles } from '@spotlight/design-system';

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

export type RecentCaptureSwipeRowProps = {
  actionRailKey: string;
  children: ReactNode;
  onActionRailVisibilityChange?: (key: string, visible: boolean) => void;
  onDelete: (id: string) => void;
  onFavorite: (id: string) => void;
  isFavorite: boolean;
  testID: string;
};

function RecentCaptureSwipeRowInner({
  actionRailKey,
  children,
  isFavorite,
  onActionRailVisibilityChange,
  onDelete,
  onFavorite,
  testID,
}: RecentCaptureSwipeRowProps) {
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

  const handleFavorite = useCallback(() => {
    onFavorite(actionRailKey);
    setIsOpen(false);
    swipeableRef.current?.close();
  }, [actionRailKey, onFavorite]);

  const handleDelete = useCallback(() => {
    onDelete(actionRailKey);
  }, [actionRailKey, onDelete]);

  const renderRightActions = useCallback(() => (
    <View style={styles.captureActionRail} testID={`${testID}-actions-underlay`}>
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
        {isFavorite ? (
          <IconHeartFilled color={favoriteHeartColor} size={16} />
        ) : (
          <IconHeart color={favoriteHeartColor} size={16} strokeWidth={2} />
        )}
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
    </View>
  ), [handleDelete, handleFavorite, isFavorite, isOpen, testID]);

  useEffect(() => {
    return () => {
      onActionRailVisibilityChange?.(actionRailKey, false);
    };
  }, [actionRailKey, onActionRailVisibilityChange]);

  return (
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
