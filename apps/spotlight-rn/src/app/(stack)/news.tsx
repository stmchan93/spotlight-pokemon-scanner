import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { NewsScreen } from '@/features/meta-feed/screens/news-screen';
import { parseGameParam, parseNewsKindParam } from '@/features/meta-feed/screens/route-params';
import { FeedMarketRouteGate } from '@/features/meta-feed/components/feed-market-route-gate';

/** `/news?kind=video&game=pokemon` — News & videos, pushed from the feed's Card news block. */
function NewsRouteContent() {
  const router = useRouter();
  const params = useLocalSearchParams<{ game?: string | string[]; kind?: string | string[] }>();
  const openCard = useCallback(
    (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } }),
    [router],
  );

  return (
    <NewsScreen
      initialGame={parseGameParam(params.game) ?? null}
      initialKind={parseNewsKindParam(params.kind) ?? null}
      onBack={() => router.back()}
      onOpenCard={openCard}
    />
  );
}

export default function NewsRoute() {
  return (
    <FeedMarketRouteGate>
      <NewsRouteContent />
    </FeedMarketRouteGate>
  );
}
