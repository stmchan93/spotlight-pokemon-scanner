import { useLocalSearchParams, useRouter } from 'expo-router';

import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import { MetaScreen } from '@/features/meta-feed/screens/meta-screen';
import { parseGameParam } from '@/features/meta-feed/screens/route-params';
import { FeedMarketRouteGate } from '@/features/meta-feed/components/feed-market-route-gate';

/** `/meta?game=pokemon` — the Meta page (always the past week, raw + graded), pushed from the feed's Meta pulse block. */
function MetaRouteContent() {
  const router = useRouter();
  const navigation = useMetaFeedNavigation();
  const params = useLocalSearchParams<{ game?: string | string[] }>();

  return (
    <MetaScreen
      initialGame={parseGameParam(params.game)}
      onBack={() => router.back()}
      onOpenGroup={navigation.openMetaGroup}
    />
  );
}

export default function MetaRoute() {
  return (
    <FeedMarketRouteGate>
      <MetaRouteContent />
    </FeedMarketRouteGate>
  );
}
