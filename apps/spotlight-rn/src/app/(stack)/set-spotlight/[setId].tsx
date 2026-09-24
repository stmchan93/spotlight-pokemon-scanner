import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { firstParam } from '@/features/meta-feed/screens/route-params';
import { SetSpotlightScreen } from '@/features/meta-feed/screens/set-spotlight-screen';

/**
 * `/set-spotlight/<setId>` — a set's spotlight page, pushed from the feed's Set
 * spotlight block. `current` opens this week's pick.
 */
export default function SetSpotlightRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ setId?: string | string[] }>();
  const setId = firstParam(params.setId);
  const openCard = useCallback(
    (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } }),
    [router],
  );

  return (
    <SetSpotlightScreen
      key={setId}
      onBack={() => router.back()}
      onOpenCard={openCard}
      setId={setId && setId !== 'current' ? setId : null}
    />
  );
}
