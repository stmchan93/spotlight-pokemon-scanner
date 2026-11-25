import { useCallback } from 'react';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import type { AssistantSetRef } from '@spotlight/api-client';

import { parseAssistantRouteParams } from '@/features/assistant/assistant-route';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';
import { LOGIN_HREF } from '@/features/auth/use-guest-gate';
import { WATCHLIST_HREF } from '@/lib/watchlist-tab';

/**
 * `/assistant?source=home|scanner&cardIds=a,b&threadId=…&game=…&page=<json>&prompt=…` — Ask Ekalight, opened by
 * the Chat pill (page = where from) or search's Ask row (prompt = sent as the first question). A form sheet on the ROOT stack (ASSISTANT_SHEET_OPTIONS).
 */
export default function AssistantRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    source?: string; cardIds?: string; threadId?: string; game?: string; page?: string; prompt?: string;
  }>();
  const { source, cardIds, threadId, game, page, prompt } = parseAssistantRouteParams(params);
  // A push after a modal joins the pushed stack UNDER it (react-native-screens),
  // so a card opened from the chat would land behind the sheet: close it first.
  const leaveTo = useCallback(
    (href: Href) => {
      router.back();
      router.push(href);
    },
    [router],
  );
  const openCard = useCallback(
    (cardId: string) => leaveTo({ pathname: '/cards/[cardId]', params: { cardId } }),
    [leaveTo],
  );
  // A set tile opens the catalog's set page; `set_id` is unique only within a game, so the game travels too.
  const openSet = useCallback(
    (set: AssistantSetRef) =>
      leaveTo({
        pathname: '/catalog/expansion/[expansionId]',
        params: { expansionId: set.setId, name: set.name, ...(set.game ? { game: set.game } : {}) },
      }),
    [leaveTo],
  );
  // The WATCHLIST tab — the same place a deal-alert tap lands.
  const openWatchlist = useCallback(() => leaveTo(WATCHLIST_HREF as Href), [leaveTo]);
  const openLogin = useCallback(() => leaveTo(LOGIN_HREF), [leaveTo]);

  return (
    <AssistantScreen
      cardIds={cardIds}
      game={game}
      initialPrompt={prompt}
      initialThreadId={threadId}
      onBack={() => router.back()}
      onOpenCard={openCard}
      onOpenLogin={openLogin}
      onOpenSet={openSet}
      onOpenWatchlist={openWatchlist}
      page={page}
      presentation="sheet"
      source={source}
    />
  );
}
