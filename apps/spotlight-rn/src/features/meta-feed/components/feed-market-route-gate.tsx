import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';

import { FEED_MARKET_FALLBACK_URL } from '@/features/meta-feed/feed-market-routes';
import { resolveFeedMarketBlocksEnabled } from '@/lib/runtime-config';

/**
 * Wraps a market/news page route. With the feed's market sections switched
 * off, a deep link or stale push into the page lands on the feed instead.
 */
export function FeedMarketRouteGate({ children }: { children: ReactNode }) {
  if (!resolveFeedMarketBlocksEnabled()) {
    return <Redirect href={FEED_MARKET_FALLBACK_URL as never} />;
  }
  return <>{children}</>;
}
