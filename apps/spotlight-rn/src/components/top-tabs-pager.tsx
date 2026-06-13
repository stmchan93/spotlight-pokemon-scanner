import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  PanResponder,
  type PanResponderGestureState,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar, setStatusBarStyle } from 'expo-status-bar';
import { useFocusEffect } from 'expo-router';

import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { TabsPageContext } from '@/contexts/tabs-page-context';

type TabsPage = 'portfolio' | 'scanner';

type TopTabsPagerProps = {
  initialPage?: TabsPage;
  portfolioSlot: ReactNode;
  renderScannerSlot: (
    onExitToPortfolio: () => void,
    onTopLevelSwipeEnabledChange: (enabled: boolean) => void,
  ) => ReactNode;
};

const swipeDistanceThreshold = 44;
const swipeVelocityThreshold = 0.45;
const swipeCompleteDuration = 180;
const swipeCancelDuration = 150;
// A page swipe may only begin when the finger first lands within this many px
// of a screen edge — left edge to pull right into Collection, right edge to
// pull left into Scanner. Dragging from the middle no longer moves the pages.
const edgeSwipeZone = 40;

function isHorizontalSwipe(gs: Pick<PanResponderGestureState, 'dx' | 'dy'>) {
  return Math.abs(gs.dx) > Math.abs(gs.dy) * 1.35;
}

export function TopTabsPager({
  initialPage = 'scanner',
  portfolioSlot,
  renderScannerSlot,
}: TopTabsPagerProps) {
  const { width } = useWindowDimensions();

  const initialTranslateX = initialPage === 'portfolio' ? 0 : -width;
  const [activePage, setActivePage] = useState<TabsPage>(initialPage);
  const activePageRef = useRef<TabsPage>(initialPage);
  const isScannerSwipeEnabledRef = useRef(true);
  const isTransitioningRef = useRef(false);
  const directionRef = useRef<'left' | 'right' | null>(null);
  const chartScrubLockRef = useRef(false);
  // Absolute screen X where the current touch first landed. Captured on touch
  // start because PanResponder's gestureState.x0 is still 0 during the
  // move-should-set decision (it's only set once the responder is granted).
  const startXRef = useRef<number | null>(null);
  const translateX = useRef(new Animated.Value(initialTranslateX)).current;

  useEffect(() => {
    const targetX = initialPage === 'portfolio' ? 0 : -width;
    activePageRef.current = initialPage;
    setActivePage(initialPage);
    directionRef.current = null;
    isTransitioningRef.current = false;
    translateX.setValue(targetX);
  }, [initialPage, translateX, width]);

  // Re-assert the status-bar style whenever the tabs screen regains focus —
  // e.g. returning from a pushed card detail / sheet / modal. The declarative
  // <StatusBar> below only re-applies when `activePage` *changes*, so without
  // this a stale "light" style can survive over the light Collection surface
  // and make the battery/time/Wi-Fi icons invisible (white-on-white).
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle(activePageRef.current === 'portfolio' ? 'dark' : 'light');
    }, []),
  );

  const goToPage = useCallback((page: TabsPage) => {
    const targetX = page === 'portfolio' ? 0 : -width;
    activePageRef.current = page;
    setActivePage(page);
    isTransitioningRef.current = true;
    directionRef.current = null;
    Animated.timing(translateX, {
      toValue: targetX,
      duration: swipeCompleteDuration,
      useNativeDriver: true,
    }).start(() => {
      isTransitioningRef.current = false;
    });
  }, [translateX, width]);

  const cancelSwipe = useCallback(() => {
    const restoreX = activePageRef.current === 'portfolio' ? 0 : -width;
    directionRef.current = null;
    Animated.timing(translateX, {
      toValue: restoreX,
      duration: swipeCancelDuration,
      useNativeDriver: true,
    }).start(() => {
      isTransitioningRef.current = false;
    });
  }, [translateX, width]);

  const handleScannerSwipeEnabledChange = useCallback((enabled: boolean) => {
    isScannerSwipeEnabledRef.current = enabled;
  }, []);

  const shouldSetResponder = useCallback((_: unknown, gs: PanResponderGestureState) => {
    if (isTransitioningRef.current || !isHorizontalSwipe(gs)) {
      return false;
    }
    // The chart's long-press scrub owns the gesture once active — don't
    // rip it out from under the user mid-drag.
    if (chartScrubLockRef.current) {
      return false;
    }
    // Require either a fast horizontal flick OR a significant horizontal
    // distance before stealing the gesture. Avoids the previous hair-
    // trigger 8px threshold that grabbed gestures during chart scrub.
    const isFastSwipe = Math.abs(gs.vx) > 0.4;
    const isLongSwipe = Math.abs(gs.dx) > 24;
    if (!isFastSwipe && !isLongSwipe) {
      return false;
    }
    // Only begin a page swipe when the finger first landed near a screen edge:
    // right edge to pull left (portfolio → scanner), left edge to pull right
    // (scanner → portfolio). Starts from the middle are ignored.
    const startX = startXRef.current;
    if (startX != null) {
      const fromLeftEdge = startX <= edgeSwipeZone;
      const fromRightEdge = startX >= width - edgeSwipeZone;
      if (activePageRef.current === 'portfolio' && !fromRightEdge) {
        return false;
      }
      if (activePageRef.current === 'scanner' && !fromLeftEdge) {
        return false;
      }
    }
    if (activePageRef.current === 'portfolio' && gs.dx < 0) {
      return true;
    }
    if (activePageRef.current === 'scanner' && !isScannerSwipeEnabledRef.current) {
      return false;
    }
    if (activePageRef.current === 'scanner' && gs.dx > 0) {
      return true;
    }
    return false;
  }, [width]);

  const panResponder = useMemo(() => PanResponder.create({
    // Record where the touch first landed (CAPTURE phase) so the edge-start check
    // in shouldSetResponder always has a fresh value. This must be capture, not
    // bubble: when the touch lands on a greedy child that claims the start —
    // the chart's scrub touch-target or a collection card Pressable — bubble-phase
    // start handlers on the pager never run, leaving startX stale from a previous
    // touch. A stale startX makes the edge check reject a genuine edge swipe, which
    // is why "swipe at the edge" worked only intermittently. Returns false so
    // recording the start never itself claims the gesture.
    onStartShouldSetPanResponderCapture: (evt) => {
      startXRef.current = evt.nativeEvent.pageX;
      return false;
    },
    // Kept as a fallback for touches that don't hit a greedy child (capture above
    // already records those too — harmless overlap).
    onStartShouldSetPanResponder: (evt) => {
      startXRef.current = evt.nativeEvent.pageX;
      return false;
    },
    onMoveShouldSetPanResponder: shouldSetResponder,
    // Capture mode only on portfolio to override the ScrollView
    onMoveShouldSetPanResponderCapture: (_, gs) =>
      activePageRef.current === 'portfolio' && shouldSetResponder(_, gs),
    onPanResponderGrant: () => {
      directionRef.current = null;
    },
    onPanResponderMove: (_, gs) => {
      if (isTransitioningRef.current || !isHorizontalSwipe(gs)) {
        return;
      }
      const page = activePageRef.current;
      const baseX = page === 'portfolio' ? 0 : -width;

      if (!directionRef.current) {
        if (gs.dx <= -8 && page === 'portfolio') {
          directionRef.current = 'left';
        } else if (gs.dx >= 8 && page === 'scanner') {
          directionRef.current = 'right';
        }
      }

      if (!directionRef.current) {
        return;
      }

      const nextX = directionRef.current === 'left'
        ? Math.max(baseX + gs.dx, -width)
        : Math.min(baseX + gs.dx, 0);
      translateX.setValue(nextX);
    },
    onPanResponderRelease: (_, gs) => {
      if (isTransitioningRef.current) {
        return;
      }
      const dir = directionRef.current;
      if (dir === 'left' && (gs.dx <= -swipeDistanceThreshold || gs.vx <= -swipeVelocityThreshold)) {
        goToPage('scanner');
        return;
      }
      if (dir === 'right' && (gs.dx >= swipeDistanceThreshold || gs.vx >= swipeVelocityThreshold)) {
        goToPage('portfolio');
        return;
      }
      cancelSwipe();
    },
    onPanResponderTerminate: () => {
      cancelSwipe();
    },
  }), [shouldSetResponder, width, translateX, goToPage, cancelSwipe]);

  const goToPortfolio = useCallback(() => goToPage('portfolio'), [goToPage]);

  return (
    <TabsPageContext.Provider value={{ activePage, chartScrubLockRef }}>
      <View {...panResponder.panHandlers} style={styles.container} testID="top-tabs-pager">
        {/* Portfolio and scanner are both mounted side-by-side. expo-status-bar
            uses the most-recently-mounted StatusBar, so we need exactly one
            here that tracks the active page — otherwise the scanner's "light"
            style leaks into the light Collection surface and hides the icons. */}
        <StatusBar style={activePage === 'portfolio' ? 'dark' : 'light'} />
        <Animated.View style={[styles.row, { width: width * 2, transform: [{ translateX }] }]}>
          <View style={[styles.slot, { width }]}>
            {portfolioSlot}
          </View>
          <View style={[styles.slot, { width }]}>
            {renderScannerSlot(goToPortfolio, handleScannerSwipeEnabledChange)}
          </View>
        </Animated.View>
        {activePage === 'portfolio' ? (
          <AppBottomTabBar
            activeKey="portfolio"
            onPressPortfolio={() => {}}
            onPressScan={() => goToPage('scanner')}
          />
        ) : null}
      </View>
    </TabsPageContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
  },
  slot: {
    flex: 1,
  },
});
