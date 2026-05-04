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
import { IconBriefcase2, IconScan } from '@tabler/icons-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FloatingBottomNav, useSpotlightTheme } from '@spotlight/design-system';

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

function isHorizontalSwipe(gs: Pick<PanResponderGestureState, 'dx' | 'dy'>) {
  return Math.abs(gs.dx) > Math.abs(gs.dy) * 1.35;
}

export function TopTabsPager({
  initialPage = 'scanner',
  portfolioSlot,
  renderScannerSlot,
}: TopTabsPagerProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const theme = useSpotlightTheme();

  const initialTranslateX = initialPage === 'portfolio' ? 0 : -width;
  const [activePage, setActivePage] = useState<TabsPage>(initialPage);
  const activePageRef = useRef<TabsPage>(initialPage);
  const isScannerSwipeEnabledRef = useRef(true);
  const isTransitioningRef = useRef(false);
  const directionRef = useRef<'left' | 'right' | null>(null);
  const translateX = useRef(new Animated.Value(initialTranslateX)).current;

  useEffect(() => {
    const targetX = initialPage === 'portfolio' ? 0 : -width;
    activePageRef.current = initialPage;
    setActivePage(initialPage);
    directionRef.current = null;
    isTransitioningRef.current = false;
    translateX.setValue(targetX);
  }, [initialPage, translateX, width]);

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
    if (activePageRef.current === 'portfolio' && gs.dx <= -8) {
      return true;
    }
    if (activePageRef.current === 'scanner' && !isScannerSwipeEnabledRef.current) {
      return false;
    }
    if (activePageRef.current === 'scanner' && gs.dx >= 8) {
      return true;
    }
    return false;
  }, []);

  const panResponder = useMemo(() => PanResponder.create({
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
    <TabsPageContext.Provider value={{ activePage }}>
      <View {...panResponder.panHandlers} style={styles.container} testID="top-tabs-pager">
        <Animated.View style={[styles.row, { width: width * 2, transform: [{ translateX }] }]}>
          <View style={[styles.slot, { width }]}>
            {portfolioSlot}
          </View>
          <View style={[styles.slot, { width }]}>
            {renderScannerSlot(goToPortfolio, handleScannerSwipeEnabledChange)}
          </View>
        </Animated.View>
        {activePage === 'portfolio' ? (
          <FloatingBottomNav
            bottomInset={Math.max(insets.bottom - 8, 0)}
            items={[
              {
                key: 'portfolio',
                label: 'Collection',
                selected: true,
                onPress: () => {},
                testID: 'bottom-nav-portfolio',
                icon: (
                  <IconBriefcase2
                    color={theme.colors.textPrimary}
                    size={20}
                    strokeWidth={2.15}
                  />
                ),
              },
              {
                key: 'scan',
                label: 'Scan',
                selected: false,
                onPress: () => goToPage('scanner'),
                testID: 'bottom-nav-scan',
                icon: (
                  <IconScan
                    color={theme.colors.textPrimary}
                    size={20}
                    strokeWidth={2.15}
                  />
                ),
              },
            ]}
            surface="default"
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
