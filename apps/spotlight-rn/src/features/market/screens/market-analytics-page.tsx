import { useCallback, type RefObject } from 'react';
import { useRouter } from 'expo-router';

import type { CollapsiblePageProps, CollapsibleScrollTarget } from '@/components/page-tab-pager';
import { TopTrendsBlock } from '@/features/market/components/top-trends-block';
import { MarketWatchPage } from '@/features/market/screens/market-watch-page';
import { useTopMovers } from '@/features/market/use-top-movers';

type MarketAnalyticsPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  testID?: string;
};

/**
 * Home → MARKET ANALYTICS (owner, 2026-11-22): the Social hub's Market Watch
 * page moved here as-is, with the Top Trends rail on top. Relocated faithfully
 * on purpose — its redesign is a later conversation.
 */
export function MarketAnalyticsPage({ page, scrollRef, testID = 'market-analytics-page' }: MarketAnalyticsPageProps) {
  const router = useRouter();
  // Reads on mount (the tab's first open), painting the shared cache meanwhile.
  const { movers, loading, refresh } = useTopMovers();

  const openCard = useCallback((cardId: string) => {
    router.push({ pathname: '/cards/[cardId]', params: { cardId } });
  }, [router]);

  return (
    <MarketWatchPage
      leading={(
        <TopTrendsBlock
          loading={loading}
          movers={movers}
          onPressCard={openCard}
          testID={`${testID}-top-trends`}
        />
      )}
      onRefresh={refresh}
      page={page}
      scrollRef={scrollRef}
      testID={testID}
    />
  );
}
