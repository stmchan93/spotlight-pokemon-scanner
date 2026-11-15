import {
  NavigationContext,
  TabActions,
  TabRouter,
  createNavigatorFactory,
  useNavigationBuilder,
  type DefaultNavigatorOptions,
  type Descriptor,
  type NavigationHelpers,
  type NavigationProp,
  type ParamListBase,
  type RouteProp,
  type TabActionHelpers,
  type TabNavigationState,
  type TabRouterOptions,
} from '@react-navigation/native';
import { withLayoutContext } from 'expo-router';
import { tabRouterOverride } from 'expo-router/build/layouts/TabRouter';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@spotlight/design-system';

import { DRAWER_EDGE_WIDTH } from '@/components/drawer-edge-swipe';
import {
  AppTabBar,
  getAppTabBarHeight,
  useTabBarBottomInset,
} from '@/components/tab-pager/app-tab-bar';
import {
  TabPagerPageContext,
  type TabPagerPageApi,
} from '@/components/tab-pager/tab-pager-page-context';
import { TabsPageContext } from '@/contexts/tabs-page-context';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { TabScreenProvider } from '@/lib/tab-bar-insets';
import {
  SCAN_PAGE_INDEX,
  TAB_PAGE_COUNT,
  TAB_PAGER_ORDER,
  clampWithRubberBand,
  isPageLive,
  landingEdgeForDirection,
  pageIndexForState,
  requestTabLanding,
  resolveOuterSwipe,
  resolveSettlePage,
  swipeDirectionFromDx,
  type InnerPagePosition,
} from '@/lib/tab-pager';
import { useKeyboardVisible } from '@/lib/use-keyboard-visible';
import { useAuth } from '@/providers/auth-provider';

/*
  ─────────────────────────────────────────────────────────────────────────────
  THE TAB PAGER — one horizontal strip of the five tab pages, dragged 1:1
  ─────────────────────────────────────────────────────────────────────────────
  Routing: see `src/app/(tabs)/_layout.tsx`. The route picks the page; a settled
  swipe dispatches JUMP_TO. `position` (in pages) is the one animated value: the
  strip's translate, the bar's light->dark blend and its sliding selection pill
  all read it on the UI thread.

  THE GESTURE is a gesture-handler Pan with MANUAL activation. Its worklet makes
  one decision per touch, at 12pt of horizontal travel (or fails at 12pt
  vertical — a scroll is never taken), entirely on the UI thread:
    1. horizontal-dominant (1.35x), single finger, not in the drawer's left band;
    2. not stamped by a guarded view (below), not locked by the page;
    3. `resolveOuterSwipe`: if the page's own inner pager (Home, Social) can
       still move this way, FAIL and leave it to that pager (it claims at 14pt);
       otherwise ACTIVATE — a neighbour slides in, or the chain's end
       rubber-bands. That is the whole inner -> outer hand-off: decided once,
       at gesture start, never switched mid-drag.
  Activation cancels the JS responder (RNGH does that natively), so the card or
  inner pager under the finger is cancelled, not tapped.

  GESTURE CONFLICTS, and how each is resolved
   - Inner pagers (Home Collection/Activity, Social Social/News/Market — JS
     PanResponders): the hand-off rule above, fed by `useTabPagerInnerPosition`.
   - Horizontal chip rows / horizontal lists (`PageSwipeGuard`: Collection
     filters, Watchlist filters, Events tabs + regions, Social game chips,
     Market Watch): a never-activating RNGH gesture on the row stamps the
     touch-down on the UI thread (`usePagerTouchGuardGesture`); a stamped touch
     is never taken. Same JS-responder guard as before for the inner pagers.
   - Watchlist + Deal Radar swipe-to-delete rows (`Swipeable`, -15pt): the row
     is wrapped in a `next`-only guard — leftward drags are the row's, rightward
     still page back to Home; an OPEN rail guards both ways.
   - DrawerEdgeSwipe: touches starting in its 24pt left band are never taken on
     the pages that host the drawer (Home, Watchlist, Social).
   - Portfolio chart scrub: its own RNGH Pan activates at 6pt (and the hold at
     250ms), before this one decides, and RNGH cancels us — composition, no flag.
   - Scanner: the tray carries the guard composed `Simultaneous` with its own
     pan (row swipes, vertical pan, binder review), and `useTabPagerLock` stands
     the strip down while the tray is expanded, binder review or any sheet/menu
     is open. Tap-to-scan and the zoom chips are taps; a Pan never activates on
     a tap. Pinch is multi-touch, which fails us.
   - Edit modes (Collection select, Watchlist edit) and typing (keyboard up —
     e.g. Collection's filter field) lock the strip.
   - Guests: off entirely; a pushed stack screen covers the strip anyway.
*/

/** Horizontal travel at which the outer strip makes its one decision for a touch. */
export const PAGER_ACTIVATE_X = 12;
/** Vertical travel that rules the touch out before then — never steal a scroll. */
export const PAGER_FAIL_Y = 12;
/** Same horizontal-dominance ratio as the drawer and the inner pagers. */
const HORIZONTAL_BIAS = 1.35;
/** A guard stamp this close to our own touch-down belongs to the same touch. */
const GUARD_WINDOW_MS = 50;
/** Bar-tap slide. */
const TAP_SLIDE_MS = 280;
/** Release spring: near-critically damped, clamped so the strip never overshoots a page. */
const SETTLE_SPRING = { damping: 30, mass: 1, overshootClamping: true, stiffness: 260 } as const;
/**
 * Left-edge band left to `DrawerEdgeSwipe` on the pages that host the drawer
 * (Home, Watchlist, Social). Scan and Events have no drawer, so no band.
 */
const EDGE_GUARD_BY_PAGE = TAB_PAGER_ORDER.map((tab) =>
  (tab === 'index' || tab === 'wishlist' || tab === 'social' ? DRAWER_EDGE_WIDTH : 0));

type TabPagerEventMap = {
  tabPress: { canPreventDefault: true; data: undefined };
};

type TabPagerNavigatorProps = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  TabNavigationState<ParamListBase>,
  object,
  TabPagerEventMap,
  NavigationProp<ParamListBase>
> & TabRouterOptions;

type ViewProps = {
  descriptors: Record<string, Descriptor<object, NavigationProp<ParamListBase>, RouteProp<ParamListBase>>>;
  navigation: NavigationHelpers<ParamListBase, TabPagerEventMap> & TabActionHelpers<ParamListBase>;
  state: TabNavigationState<ParamListBase>;
};

/** React Navigation's TabRouter with expo-router's REPLACE -> JUMP_TO override, as `<Tabs>` uses. */
export const ExpoTabRouter = (options: TabRouterOptions) =>
  (tabRouterOverride as unknown as (router: ReturnType<typeof TabRouter>) => ReturnType<typeof TabRouter>)(
    TabRouter(options),
  );

function TabPagerNavigator({
  backBehavior,
  children,
  id,
  initialRouteName,
  screenListeners,
  screenOptions,
}: TabPagerNavigatorProps) {
  const { descriptors, navigation, NavigationContent, state } = useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    object,
    TabPagerEventMap
  >(ExpoTabRouter, {
    backBehavior,
    children,
    id,
    initialRouteName,
    screenListeners,
    screenOptions,
  });

  return (
    <NavigationContent>
      <TabPagerView descriptors={descriptors} navigation={navigation} state={state} />
    </NavigationContent>
  );
}

const createTabPagerNavigator = createNavigatorFactory(TabPagerNavigator);

/** The `(tabs)` layout's navigator: expo-router routes in, a draggable strip out. */
export const TabPager = withLayoutContext(createTabPagerNavigator().Navigator);

/**
 * Focus of the `(tabs)` screen itself in the root stack — false while a pushed
 * screen covers the pager. Listener-based rather than `useIsFocused` so the
 * pager also renders outside a navigator (it never is in the app).
 */
function useParentFocused(): boolean {
  const parent = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => parent?.isFocused() ?? true);
  useEffect(() => {
    if (!parent) {
      return;
    }
    setFocused(parent.isFocused());
    const unsubscribeFocus = parent.addListener('focus', () => setFocused(true));
    const unsubscribeBlur = parent.addListener('blur', () => setFocused(false));
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [parent]);
  return focused;
}

function TabPagerView({ descriptors, navigation, state }: ViewProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bottomInset = useTabBarBottomInset();
  const barHeight = getAppTabBarHeight(bottomInset);
  const { isGuest } = useAuth();
  const parentFocused = useParentFocused();
  const keyboardUp = useKeyboardVisible();
  // ANDROID: the bar hides while the keyboard is up — see `useKeyboardVisible`.
  const barHidden = Platform.OS === 'android' && keyboardUp;

  const focusedPage = pageIndexForState(state);
  const initialPage = focusedPage >= 0 ? focusedPage : 0;

  /** Strip position in PAGES (0 = Home). The single source every animation reads. */
  const position = useSharedValue(initialPage);
  const widthSV = useSharedValue(width);
  useEffect(() => {
    widthSV.value = width;
  }, [width, widthSV]);

  const [settledPage, setSettledPage] = useState(initialPage);
  const [mountedPages, setMountedPages] = useState<ReadonlySet<number>>(() => new Set([initialPage]));
  const mountPage = useCallback((page: number) => {
    setMountedPages((current) => (current.has(page) ? current : new Set(current).add(page)));
  }, []);

  // ── UI-thread mirrors of what the hand-off rule needs ──────────────────────
  const innerPositions = useSharedValue<(InnerPagePosition | null)[]>(TAB_PAGER_ORDER.map(() => null));
  const lockedPages = useSharedValue<boolean[]>(TAB_PAGER_ORDER.map(() => false));
  const globalLock = useSharedValue(false);
  const guardedAt = useSharedValue(0);
  const guardedStep = useSharedValue(0);
  useEffect(() => {
    // While typing nobody is paging; a pushed screen covers the strip.
    globalLock.value = keyboardUp || !parentFocused;
  }, [globalLock, keyboardUp, parentFocused]);

  const locksRef = useRef(TAB_PAGER_ORDER.map(() => new Set<string>()));
  const pageApis = useMemo<TabPagerPageApi[]>(
    () => TAB_PAGER_ORDER.map((_tab, page) => ({
      guardedAt,
      guardedStep,
      page,
      setInner: (inner: InnerPagePosition | null) => {
        const next = innerPositions.value.slice();
        next[page] = inner;
        innerPositions.value = next;
      },
      setLock: (key: string, locked: boolean) => {
        const keys = locksRef.current[page];
        if (!keys) {
          return;
        }
        if (locked) {
          keys.add(key);
        } else {
          keys.delete(key);
        }
        const next = lockedPages.value.slice();
        next[page] = keys.size > 0;
        lockedPages.value = next;
      },
    })),
    [guardedAt, guardedStep, innerPositions, lockedPages],
  );

  // ── Route -> strip ─────────────────────────────────────────────────────────
  /** The page a finished swipe just put the strip on, so the route echo doesn't re-animate. */
  const settledBySwipeRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusedPage < 0) {
      return;
    }
    mountPage(focusedPage);
    if (settledBySwipeRef.current === focusedPage) {
      settledBySwipeRef.current = null;
      setSettledPage(focusedPage);
      return;
    }
    settledBySwipeRef.current = null;
    // A tap, a deep link, router.navigate, a guest redirect, Android back…
    position.value = withTiming(
      focusedPage,
      { duration: TAP_SLIDE_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) {
          runOnJS(setSettledPage)(focusedPage);
        }
      },
    );
  }, [focusedPage, mountPage, position]);

  // ── Strip -> route ─────────────────────────────────────────────────────────
  const latest = useRef({ focusedPage, navigation, state });
  latest.current = { focusedPage, navigation, state };

  const handleSwipeSettled = useCallback((page: number, fromPage: number) => {
    const current = latest.current;
    if (page === current.focusedPage) {
      setSettledPage(page);
      return;
    }
    const name = TAB_PAGER_ORDER[page];
    if (!name) {
      return;
    }
    settledBySwipeRef.current = page;
    current.navigation.dispatch({ ...TabActions.jumpTo(name), target: current.state.key });
    capturePostHogEvent(AnalyticsEvent.tabSwipeNavigated, {
      direction: page > fromPage ? 'next' : 'previous',
      from_tab: TAB_PAGER_ORDER[fromPage] ?? null,
      to_tab: name,
    });
  }, []);

  /** A neighbour starts sliding in: mount it and ask it for its near inner page. */
  const handleReveal = useCallback((page: number, step: number) => {
    mountPage(page);
    const tab = TAB_PAGER_ORDER[page];
    if (tab) {
      requestTabLanding(tab, landingEdgeForDirection(step > 0 ? 'next' : 'previous'));
    }
  }, [mountPage]);

  const handleSelectPage = useCallback((page: number) => {
    const current = latest.current;
    const route = current.state.routes.find((candidate) => candidate.name === TAB_PAGER_ORDER[page]);
    if (!route) {
      return;
    }
    const event = current.navigation.emit({ canPreventDefault: true, target: route.key, type: 'tabPress' });
    if (page !== current.focusedPage && !event.defaultPrevented) {
      current.navigation.dispatch({ ...TabActions.jumpTo(route.name, route.params), target: current.state.key });
    }
  }, []);

  // ── The gesture ────────────────────────────────────────────────────────────
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const downAt = useSharedValue(0);
  const startPage = useSharedValue(0);
  const decided = useSharedValue(false);
  const startPosition = useSharedValue(0);
  const activationTx = useSharedValue(0);

  const gestureEnabled = !isGuest && focusedPage >= 0;
  const pan = useMemo(() => Gesture.Pan()
    .manualActivation(true)
    .enabled(gestureEnabled)
    .failOffsetY([-PAGER_FAIL_Y, PAGER_FAIL_Y])
    .onTouchesDown((event, stateManager) => {
      'worklet';
      const touch = event.changedTouches[0];
      if (!touch || event.numberOfTouches > 1) {
        stateManager.fail();
        return;
      }
      startX.value = touch.absoluteX;
      startY.value = touch.absoluteY;
      downAt.value = Date.now();
      decided.value = false;
      const page = Math.min(Math.max(Math.round(position.value), 0), TAB_PAGE_COUNT - 1);
      startPage.value = page;
      if (globalLock.value || lockedPages.value[page]) {
        stateManager.fail();
        return;
      }
      // The drawer's left-edge band.
      if (touch.absoluteX <= (EDGE_GUARD_BY_PAGE[page] ?? 0)) {
        stateManager.fail();
      }
    })
    .onTouchesMove((event, stateManager) => {
      'worklet';
      if (decided.value) {
        return;
      }
      const touch = event.allTouches[0];
      if (!touch || event.numberOfTouches > 1) {
        decided.value = true;
        stateManager.fail();
        return;
      }
      const dx = touch.absoluteX - startX.value;
      const dy = touch.absoluteY - startY.value;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx < PAGER_ACTIVATE_X) {
        if (ady >= PAGER_FAIL_Y) {
          decided.value = true;
          stateManager.fail();
        }
        return;
      }
      decided.value = true;
      const page = startPage.value;
      const direction = swipeDirectionFromDx(dx);
      // A guarded view (chip row, scanner tray, a delete-swipe row) took this
      // touch at touch-down — for both directions, or only for `next`.
      const guarded = guardedAt.value >= downAt.value - GUARD_WINDOW_MS
        && (guardedStep.value === 0 || (guardedStep.value === 1) === (direction === 'next'));
      if (adx <= ady * HORIZONTAL_BIAS || guarded || globalLock.value || lockedPages.value[page]) {
        stateManager.fail();
        return;
      }
      const decision = resolveOuterSwipe(page, direction, innerPositions.value[page]);
      if (decision.owner === 'inner') {
        // The page's own pager can still move this way; it claims at 14pt.
        stateManager.fail();
        return;
      }
      if (decision.target !== null) {
        runOnJS(handleReveal)(decision.target, direction === 'next' ? 1 : -1);
      }
      stateManager.activate();
    })
    .onStart((event) => {
      'worklet';
      cancelAnimation(position);
      startPosition.value = position.value;
      activationTx.value = event.translationX;
    })
    .onUpdate((event) => {
      'worklet';
      const pageWidth = widthSV.value;
      if (pageWidth <= 0) {
        return;
      }
      // 1:1 with the finger, measured from the activation point so nothing jumps.
      const raw = startPosition.value - (event.translationX - activationTx.value) / pageWidth;
      position.value = clampWithRubberBand(raw);
    })
    .onEnd((event, success) => {
      'worklet';
      const from = startPage.value;
      const target = success
        ? resolveSettlePage({ position: position.value, startPage: from, velocityX: event.velocityX })
        : from;
      const pageWidth = widthSV.value > 0 ? widthSV.value : 1;
      position.value = withSpring(
        target,
        { ...SETTLE_SPRING, velocity: -event.velocityX / pageWidth },
        (finished) => {
          if (finished) {
            runOnJS(handleSwipeSettled)(target, from);
          }
        },
      );
    }), [
    activationTx,
    decided,
    downAt,
    gestureEnabled,
    globalLock,
    guardedAt,
    guardedStep,
    handleReveal,
    handleSwipeSettled,
    innerPositions,
    lockedPages,
    position,
    startPage,
    startPosition,
    startX,
    startY,
    widthSV,
  ]);

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -position.value * widthSV.value }],
  }));

  const pageRoutes = TAB_PAGER_ORDER.map((name) => state.routes.find((route) => route.name === name));
  const focusedRoute = state.routes[state.index];
  // `/you` and `/portfolio` are routes but not pages: they only exist to redirect.
  const overlayRoute = focusedPage < 0 ? focusedRoute : undefined;

  return (
    <View style={styles.root} testID="tab-pager">
      <GestureDetector gesture={pan}>
        {/* Static host: the gesture is measured against a view that does not move. */}
        <View collapsable={false} style={styles.root}>
          <Reanimated.View
            collapsable={false}
            style={[styles.strip, { width: width * TAB_PAGE_COUNT }, stripStyle]}
            testID="tab-pager-strip"
          >
            {pageRoutes.map((route, page) => (
              <TabPagerPage
                active={isPageLive({ focusedPage, page, parentFocused, settledPage })}
                api={pageApis[page]!}
                barHeight={barHidden ? 0 : barHeight}
                focused={focusedPage === page}
                insets={insets}
                key={TAB_PAGER_ORDER[page]}
                page={page}
                render={route && mountedPages.has(page) ? descriptors[route.key]?.render : undefined}
                width={width}
              />
            ))}
          </Reanimated.View>
        </View>
      </GestureDetector>
      {overlayRoute ? (
        <View style={StyleSheet.absoluteFill}>{descriptors[overlayRoute.key]?.render()}</View>
      ) : null}
      {barHidden ? null : (
        <AppTabBar
          bottomInset={bottomInset}
          focusedPage={focusedPage}
          onSelectPage={handleSelectPage}
          position={position}
        />
      )}
    </View>
  );
}

type TabPagerPageProps = {
  /** Focused route AND the strip at rest on it AND not covered by a pushed screen. */
  active: boolean;
  api: TabPagerPageApi;
  barHeight: number;
  focused: boolean;
  insets: ReturnType<typeof useSafeAreaInsets>;
  page: number;
  render: (() => ReactNode) | undefined;
  width: number;
};

/**
 * One page of the strip, with everything a tab screen used to get from its
 * native tab: focus (from the navigator itself), `TabsPageContext`, and bottom
 * insets that include the bar.
 */
const TabPagerPage = memo(function TabPagerPage({
  active,
  api,
  barHeight,
  focused,
  insets,
  page,
  render,
  width,
}: TabPagerPageProps) {
  const isScan = page === SCAN_PAGE_INDEX;
  const chartScrubLockRef = useRef(false);
  const [collectionEditing, setCollectionEditing] = useState(false);
  useEffect(() => {
    api.setLock('collection-editing', collectionEditing);
  }, [api, collectionEditing]);

  const tabsPageValue = useMemo(() => {
    const mine = isScan ? 'scanner' : 'portfolio';
    const other = isScan ? 'portfolio' : 'scanner';
    return {
      activePage: (active ? mine : other) as 'portfolio' | 'scanner',
      chartScrubLockRef,
      collectionEditing,
      setCollectionEditing,
    };
  }, [active, collectionEditing, isScan]);

  /*
    BOTTOM INSETS, kept to what the native tabs gave every screen:
     - iOS: `useSafeAreaInsets().bottom` INCLUDES the bar, and content runs
       full-bleed under it (it is translucent glass);
     - Android: the CONTAINER is pre-inset above the (opaque) bar, and the
       insets keep reporting the system navigation bar only.
    See `@/lib/tab-bar-insets`. Scan opts out of both: the scanner reserves the
    bar's space itself, from the same `getAppTabBarHeight`.
  */
  const iosInsets = useMemo(
    () => ({ ...insets, bottom: Math.max(barHeight, insets.bottom) }),
    [barHeight, insets],
  );
  let content: ReactNode = render ? render() : null;
  if (!isScan && content) {
    content = Platform.OS === 'ios'
      ? <SafeAreaInsetsContext.Provider value={iosInsets}>{content}</SafeAreaInsetsContext.Provider>
      : content;
    content = <TabScreenProvider>{content}</TabScreenProvider>;
  }

  return (
    <View
      accessibilityElementsHidden={!focused}
      collapsable={false}
      importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
      style={[
        styles.page,
        { width },
        isScan ? styles.scanPage : null,
        !isScan && Platform.OS === 'android' ? { paddingBottom: barHeight || insets.bottom } : null,
      ]}
      testID={`tab-pager-page-${TAB_PAGER_ORDER[page]}`}
    >
      <TabPagerPageContext.Provider value={api}>
        <TabsPageContext.Provider value={tabsPageValue}>{content}</TabsPageContext.Provider>
      </TabPagerPageContext.Provider>
    </View>
  );
});

const styles = StyleSheet.create({
  page: {
    height: '100%',
    overflow: 'hidden',
  },
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  scanPage: {
    // The viewfinder is black; never flash the white theme background under it.
    backgroundColor: colors.scannerCanvas,
  },
  strip: {
    flex: 1,
    flexDirection: 'row',
  },
});
