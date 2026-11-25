import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PageTabs, spacing, useSpotlightTheme, type PageTab } from '@spotlight/design-system';

import {
  CollapsibleTabPager,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { useTabLanding, useTabPagerInnerPosition } from '@/components/tab-pager/tab-pager-page-context';
import { useTabsPage } from '@/contexts/tabs-page-context';
import {
  useAssistantPageContext,
  type AssistantPageExtra,
} from '@/features/assistant/page-context/assistant-page-context';
import { MarketAnalyticsPage } from '@/features/market/screens/market-analytics-page';
import { WatchlistPage } from '@/features/wishlist/screens/wishlist-screen';
import { innerPageForLanding } from '@/lib/tab-pager';
import { WATCHLIST_PAGE_TABS, type WatchlistPageTab } from '@/lib/watchlist-tab';

const TABS: readonly PageTab<WatchlistPageTab>[] = [
  { value: 'watchlist', label: 'Watchlist' },
  { value: 'market', label: 'Market Analytics' },
];

type WatchlistTabScreenProps = {
  /** A page the route asked for (`/wishlist?tab=market`). */
  requestedTab?: WatchlistPageTab | null;
  /** Called once `requestedTab` is applied, so the route can clear its param. */
  onRequestedTabHandled?: () => void;
  testID?: string;
};

/**
 * The WATCHLIST bottom tab: WATCHLIST and MARKET ANALYTICS under one underline
 * rail, the same rail and drag-following pages Home's profile tabs use.
 * MARKET ANALYTICS mounts on first visit, so opening the tab reads only the
 * watchlist.
 */
export function WatchlistTabScreen({
  requestedTab = null,
  onRequestedTabHandled,
  testID = 'watchlist-tab',
}: WatchlistTabScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { activePage } = useTabsPage();
  const [activeTab, setActiveTab] = useState<WatchlistPageTab>('watchlist');
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<WatchlistPageTab>>(() => new Set(['watchlist']));
  const [isWatchlistEditing, setIsWatchlistEditing] = useState(false);

  const selectTab = useCallback((next: WatchlistPageTab) => {
    setActiveTab(next);
    setVisitedTabs((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);

  useEffect(() => {
    if (!requestedTab) {
      return;
    }
    selectTab(requestedTab);
    onRequestedTabHandled?.();
  }, [onRequestedTabHandled, requestedTab, selectTab]);

  // Revealed from the outer strip: land on the near edge (WATCHLIST from Scan,
  // MARKET ANALYTICS coming back from Social).
  useTabLanding('wishlist', (edge) => {
    const page = innerPageForLanding(WATCHLIST_PAGE_TABS, edge);
    if (page) {
      selectTab(page);
    }
  });
  useTabPagerInnerPosition({
    count: WATCHLIST_PAGE_TABS.length,
    index: WATCHLIST_PAGE_TABS.indexOf(activeTab),
  });

  // MARKET ANALYTICS publishes its game/window/zoomed set while it is on screen;
  // WATCHLIST falls through to the route's own context (`/wishlist`).
  const marketAssistantContextRef = useRef<AssistantPageExtra | null>(null);
  useAssistantPageContext(() => (activeTab === 'market' ? marketAssistantContextRef.current : null));

  const watchlistScrollRef = useRef<CollapsibleScrollTarget>(null);
  const marketScrollRef = useRef<CollapsibleScrollTarget>(null);
  const pageRefs = useMemo(
    () => ({ watchlist: watchlistScrollRef, market: marketScrollRef }),
    [],
  );

  const isPageActive = activePage === 'portfolio';
  const headerHeight = insets.top + spacing.lg;

  const renderPage = (tab: WatchlistPageTab, page: CollapsiblePageProps) => {
    if (!visitedTabs.has(tab)) {
      return <View style={styles.fill} testID={`${testID}-${tab}-placeholder`} />;
    }
    if (tab === 'market') {
      return (
        <MarketAnalyticsPage
          assistantContextRef={marketAssistantContextRef}
          page={page}
          scrollRef={marketScrollRef}
          testID={`${testID}-market-page`}
        />
      );
    }
    return (
      <WatchlistPage
        isActive={isPageActive && activeTab === 'watchlist'}
        onEditModeChange={setIsWatchlistEditing}
        page={page}
        scrollRef={watchlistScrollRef}
      />
    );
  };

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.fill, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <CollapsibleTabPager
        // Pages run `contentInsetAdjustmentBehavior="automatic"`, so UIKit already
        // insets them by the top safe area; the chrome must not reserve it twice.
        contentInsetTop={Platform.OS === 'ios' ? insets.top : 0}
        disabled={isWatchlistEditing}
        header={<View style={{ backgroundColor: theme.colors.gray0, height: headerHeight }} />}
        onChange={selectTab}
        order={WATCHLIST_PAGE_TABS}
        pageRefs={pageRefs}
        // Same height as the header, so nothing collapses and the rail stays put.
        pinnedTopInset={headerHeight}
        renderPage={renderPage}
        tabBar={
          <View style={{ backgroundColor: theme.colors.gray0 }}>
            <PageTabs
              onChange={selectTab}
              tabs={TABS}
              testID={`${testID}-tabs`}
              uppercase
              value={activeTab}
              variant="underline"
            />
          </View>
        }
        testID={`${testID}-pager`}
        value={activeTab}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
