import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { NavArrowLeft, ShareIos } from 'iconoir-react-native';

import type { PortfolioPerformance } from '@spotlight/api-client';
import { colors, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { PerformanceTable } from '@/features/insights/components/performance-table';

const currentYear = new Date().getFullYear();

/**
 * Insights = the "{year} Performance Tracker" (Figma 2100-1755): a per-card
 * table showing how each holding has done this year (YTD price movement),
 * alongside its current value, $Total, and cost basis. The card-identity column
 * stays frozen while Chart/Current/$G/L/%G/L/$Total/Cost scroll horizontally.
 */
export function InsightsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const handleTabBarScroll = useTabBarScrollHandler();
  const { spotlightRepository, dataVersion } = useAppServices();

  const [performance, setPerformance] = useState<PortfolioPerformance | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const { isVisible: showScrollTop, handleScroll, handleLayout, scrollToTop } = useScrollToTop(
    scrollRef,
    handleTabBarScroll,
  );

  const load = useCallback(async () => {
    try {
      const result = await spotlightRepository.getPortfolioPerformance();
      setPerformance(result);
    } catch {
      // Keep the last value; the refresh control + next focus will retry.
    }
  }, [spotlightRepository]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleShare = useCallback(() => {
    void Share.share({ message: 'My Ekalight insights' });
  }, []);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  // Show just the first 10 cards for now.
  const rows = (performance?.rows ?? []).slice(0, 10);
  const currencyCode = performance?.currencyCode ?? 'USD';
  const itemCount = rows.length;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <View
        style={[
          styles.headerRow,
          {
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
      >
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={12}
          onPress={handleBack}
          style={styles.headerButton}
          testID="insights-header-back"
        >
          <NavArrowLeft color={colors.gray900} height={24} width={24} />
        </Pressable>
        <Text style={styles.headerTitle} testID="insights-header-title">
          Insights
        </Text>
        <Pressable
          accessibilityLabel="Share insights"
          accessibilityRole="button"
          hitSlop={12}
          onPress={handleShare}
          style={styles.headerButton}
          testID="insights-header-share"
        >
          <ShareIos color={colors.gray900} height={20} width={20} />
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomNavClearance + 16 }]}
        onLayout={handleLayout}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            onRefresh={handleRefresh}
            refreshing={isRefreshing}
            tintColor={colors.gray400}
          />
        }
        testID="insights-scroll"
      >
        <View style={styles.titleRow}>
          <Text
            style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}
            testID="insights-tracker-title"
          >
            {currentYear} Performance Tracker
          </Text>
          <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
            {`${itemCount} Item${itemCount === 1 ? '' : 's'}`}
          </Text>
        </View>

        <View style={[styles.tab, { backgroundColor: theme.colors.gray900 }]}>
          <Text style={[theme.typography.captionMedium, { color: theme.colors.gray0 }]}>
            PORTFOLIO
          </Text>
        </View>

        {rows.length > 0 ? (
          <PerformanceTable rows={rows} currencyCode={currencyCode} />
        ) : (
          <Text
            style={[theme.typography.body, styles.emptyText, { color: theme.colors.gray500 }]}
            testID="insights-empty"
          >
            {performance ? 'No cards in your portfolio yet.' : 'Loading your performance…'}
          </Text>
        )}
      </ScrollView>

      <ScrollToTopFab onPress={scrollToTop} testID="insights-scroll-to-top" visible={showScrollTop} />
      <CollectionAddFab />

      <AppBottomTabBar activeKey="portfolio" dismissToTabs />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerButton: {
    alignItems: 'center',
    backgroundColor: colors.gray50,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  headerTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
    flex: 1,
    textAlign: 'center',
  },
  scrollContent: {
    gap: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tab: {
    alignSelf: 'flex-start',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  emptyText: {
    paddingVertical: 48,
    textAlign: 'center',
  },
});

export default InsightsScreen;
