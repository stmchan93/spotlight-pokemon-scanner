import { useLocalSearchParams, useRouter } from 'expo-router';

import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import { MetaGroupScreen } from '@/features/meta-feed/screens/meta-group-screen';
import {
  firstParam,
  parseGameParam,
  parseLaneParam,
  parseWindowParam,
} from '@/features/meta-feed/screens/route-params';
import { FeedMarketRouteGate } from '@/features/meta-feed/components/feed-market-route-gate';

/**
 * `/meta/group/<groupKey>?game=pokemon&window=7&lane=graded` — one group's
 * page, pushed from any Meta pulse / Meta page bar row. `&mine=1` (from the
 * "Your SIRs are down…" callout) shows only the viewer's cards.
 */
function MetaGroupRouteContent() {
  const router = useRouter();
  const navigation = useMetaFeedNavigation();
  const params = useLocalSearchParams<{
    game?: string | string[];
    groupKey?: string | string[];
    lane?: string | string[];
    mine?: string | string[];
    window?: string | string[];
  }>();
  const groupKey = firstParam(params.groupKey);

  return (
    <MetaGroupScreen
      key={groupKey}
      game={parseGameParam(params.game)}
      groupKey={groupKey}
      lane={parseLaneParam(params.lane)}
      mineOnly={firstParam(params.mine) === '1'}
      onBack={() => router.back()}
      onOpenCard={navigation.openCard}
      windowDays={parseWindowParam(params.window)}
    />
  );
}

export default function MetaGroupRoute() {
  return (
    <FeedMarketRouteGate>
      <MetaGroupRouteContent />
    </FeedMarketRouteGate>
  );
}
