import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { parseAssistantRouteParams } from '@/features/assistant/assistant-route';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

/** `/assistant?source=home|scanner&cardIds=a,b&threadId=…` — Ask Ekalight, pushed from Home and the Scanner. */
export default function AssistantRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; cardIds?: string; threadId?: string }>();
  const { source, cardIds, threadId } = parseAssistantRouteParams(params);
  const openCard = useCallback(
    (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } }),
    [router],
  );
  // Same push the deal-alert notification tap uses to reach the Watchlist tab.
  const openWatchlist = useCallback(() => router.push('/wishlist'), [router]);

  return (
    <AssistantScreen
      cardIds={cardIds}
      initialThreadId={threadId}
      onBack={() => router.back()}
      onOpenCard={openCard}
      onOpenWatchlist={openWatchlist}
      source={source}
    />
  );
}
