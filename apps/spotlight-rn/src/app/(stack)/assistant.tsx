import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { AssistantSetRef } from '@spotlight/api-client';

import { parseAssistantRouteParams } from '@/features/assistant/assistant-route';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

/** `/assistant?source=home|scanner&cardIds=a,b&threadId=…&game=…` — Ask Ekalight, pushed from Home and the Scanner. */
export default function AssistantRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; cardIds?: string; threadId?: string; game?: string }>();
  const { source, cardIds, threadId, game } = parseAssistantRouteParams(params);
  const openCard = useCallback(
    (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } }),
    [router],
  );
  // A set tile opens the catalog's set page; `set_id` is unique only within a game, so the game travels too.
  const openSet = useCallback(
    (set: AssistantSetRef) =>
      router.push({
        pathname: '/catalog/expansion/[expansionId]',
        params: { expansionId: set.setId, name: set.name, ...(set.game ? { game: set.game } : {}) },
      }),
    [router],
  );
  // Same push the deal-alert notification tap uses to reach the Watchlist tab.
  const openWatchlist = useCallback(() => router.push('/wishlist'), [router]);

  return (
    <AssistantScreen
      cardIds={cardIds}
      game={game}
      initialThreadId={threadId}
      onBack={() => router.back()}
      onOpenCard={openCard}
      onOpenSet={openSet}
      onOpenWatchlist={openWatchlist}
      source={source}
    />
  );
}
