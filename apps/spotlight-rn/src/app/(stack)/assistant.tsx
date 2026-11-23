import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { AssistantSetRef } from '@spotlight/api-client';

import { parseAssistantRouteParams } from '@/features/assistant/assistant-route';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';
import { HOME_WATCHLIST_HREF } from '@/lib/home-profile-tab';

/** `/assistant?source=home|scanner&cardIds=a,b&threadId=…&game=…&page=<json>` — Ask Ekalight, opened by the floating bubble (page = where from). */
export default function AssistantRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; cardIds?: string; threadId?: string; game?: string; page?: string }>();
  const { source, cardIds, threadId, game, page } = parseAssistantRouteParams(params);
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
  // Home on its WATCHLIST profile tab — the same place a deal-alert tap lands.
  const openWatchlist = useCallback(() => router.push(HOME_WATCHLIST_HREF as never), [router]);

  return (
    <AssistantScreen
      cardIds={cardIds}
      game={game}
      initialThreadId={threadId}
      onBack={() => router.back()}
      onOpenCard={openCard}
      onOpenSet={openSet}
      onOpenWatchlist={openWatchlist}
      page={page}
      source={source}
    />
  );
}
