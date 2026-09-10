import { useCallback, useRef, useState, type RefObject } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';



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
  /**
   * The `contentOffset.y` that means "the top", for a scroller that does not
   * rest at 0.
   *
   * A scroll view running `contentInsetAdjustmentBehavior="automatic"` is inset
   * by UIKit and rests at `-adjustedContentInset.top` — so on the Portfolio
   * pager the top is `-insets.top`, not 0. This hook assumed 0 in both places it
   * uses an offset, which left "Back to top" landing a status bar short of the
   * actual top and the FAB appearing a status bar late. Same origin confusion
   * `CollapsibleTabPager`'s `pageTop` fixes; the value is the same number.
   *
   * NEGATIVE for an inset scroller, 0 (the default) for an ordinary one, so
   * every existing caller is byte-for-byte unchanged.
   */
  topOffset = 0,
) {
  const [isVisible, setIsVisible] = useState(false);
  const viewportHeight = useRef(0);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    viewportHeight.current = event.nativeEvent.layout.height;
  }, []);

  const handleScroll = useCallback(
    (event: ScrollEvent) => {
      onScroll?.(event);
      // How far the user has actually TRAVELLED, which is the offset measured
      // from this scroller's own top — not the raw offset, which already starts
      // at `topOffset` on an inset page and would show the button late.
      const travelled = event.nativeEvent.contentOffset.y - topOffset;
      // "Past the initial viewport" = scrolled roughly one screen height down.
      // Fall back to a fixed threshold before onLayout has measured the frame.
      const threshold = viewportHeight.current > 0 ? viewportHeight.current : 600;
      setIsVisible((prev) => {
        const next = travelled > threshold;
        return prev === next ? prev : next;
      });
    },
    [onScroll, topOffset],
  );

  const scrollToTop = useCallback(() => {
    const target = scrollRef.current;
    if (target?.scrollToOffset) {
      target.scrollToOffset({ offset: topOffset, animated: true });
    } else {
      target?.scrollTo?.({ y: topOffset, animated: true });
    }
  }, [scrollRef, topOffset]);

  return { isVisible, handleScroll, handleLayout, scrollToTop };
}

