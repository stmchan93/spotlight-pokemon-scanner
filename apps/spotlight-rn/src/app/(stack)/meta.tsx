import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { MetaScreen } from '@/features/meta-feed/screens/meta-screen';
import { parseGameParam, parseLaneParam, parseWindowParam } from '@/features/meta-feed/screens/route-params';

/** `/meta?game=pokemon&lane=all&window=7` — the Meta page, pushed from the feed's Meta pulse block. */
export default function MetaRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ game?: string | string[]; lane?: string | string[]; window?: string | string[] }>();
  const openCard = useCallback(
    (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } }),
    [router],
  );

  return (
    <MetaScreen
      initialGame={parseGameParam(params.game)}
      initialLane={parseLaneParam(params.lane)}
      initialWindowDays={parseWindowParam(params.window)}
      onBack={() => router.back()}
      onOpenCard={openCard}
    />
  );
}
