import { useCallback, useRef, useState, type RefObject } from 'react';
import {
  StyleSheet,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScrollToTopButton, bottomTabBarHeight } from '@spotlight/design-system';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

// Works for both a `ScrollView` (`scrollTo`) and a `FlatList`/`SectionList`
// (`scrollToOffset`) so the same hook drives virtualized and non-virtualized
// scrollers alike.
type ScrollToTopTarget = {
  scrollTo?: (options: { y?: number; animated?: boolean }) => void;
  scrollToOffset?: (options: { offset: number; animated?: boolean }) => void;
};

/**
 * Tracks the vertical scroll offset of a ScrollView and reports whether the
 * user has scrolled past roughly one viewport — the trigger for the floating
 * "Back to top" button (Figma 1252-1335). Composes with an optional existing
 * onScroll handler (e.g. the bottom-tab-bar chrome handler) so callers don't
 * have to drop it.
 */
export function useScrollToTop(
  scrollRef: RefObject<ScrollToTopTarget | null>,
  onScroll?: (event: ScrollEvent) => void,
) {
  const [isVisible, setIsVisible] = useState(false);
  const viewportHeight = useRef(0);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    viewportHeight.current = event.nativeEvent.layout.height;
  }, []);

  const handleScroll = useCallback(
    (event: ScrollEvent) => {
      onScroll?.(event);
      const offsetY = event.nativeEvent.contentOffset.y;
      // "Past the initial viewport" = scrolled roughly one screen height down.
      // Fall back to a fixed threshold before onLayout has measured the frame.
      const threshold = viewportHeight.current > 0 ? viewportHeight.current : 600;
      setIsVisible((prev) => {
        const next = offsetY > threshold;
        return prev === next ? prev : next;
      });
    },
    [onScroll],
  );

  const scrollToTop = useCallback(() => {
    const target = scrollRef.current;
    if (target?.scrollToOffset) {
      target.scrollToOffset({ offset: 0, animated: true });
    } else {
      target?.scrollTo?.({ y: 0, animated: true });
    }
  }, [scrollRef]);

  return { isVisible, handleScroll, handleLayout, scrollToTop };
}

type ScrollToTopFabProps = {
  visible: boolean;
  onPress: () => void;
  testID?: string;
};

/**
 * Positions the shared `ScrollToTopButton` as a floating affordance stacked
 * directly above the `+` add FAB at the bottom-right of the collection / sales
 * / wishlist screens.
 */
// Mirror CollectionAddFab: it's a 40pt-tall FAB anchored 16px above the bottom
// tab bar. We stack 12px above it (Figma 1263-2822).
const ADD_FAB_HEIGHT = 40;
const STACK_GAP = 12;

export function ScrollToTopFab({ visible, onPress, testID }: ScrollToTopFabProps) {
  const insets = useSafeAreaInsets();

  // Use CollectionAddFab's exact bottom math (insets.bottom + bottomTabBarHeight
  // + 16), then lift one FAB-height + a 12px gap so the up button sits exactly
  // 12px above the + button.
  const bottom =
    Math.max(insets.bottom, 0) + bottomTabBarHeight + 16 + ADD_FAB_HEIGHT + STACK_GAP;

  return (
    <ScrollToTopButton
      onPress={onPress}
      style={[styles.fab, { bottom }]}
      testID={testID}
      visible={visible}
    />
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 16,
  },
});
