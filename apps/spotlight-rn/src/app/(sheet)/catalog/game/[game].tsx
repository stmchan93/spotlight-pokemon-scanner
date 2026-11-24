import { useLocalSearchParams, useRouter } from 'expo-router';

import { CARD_GAMES, DEFAULT_CARD_GAME } from '@spotlight/api-client';

import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { GameSetsScreen, type GameSetsView } from '@/features/catalog/screens/game-sets-screen';
import { useAppServices } from '@/providers/app-providers';

export default function GameSetsRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const params = useLocalSearchParams<{ game?: string | string[]; view?: string | string[] }>();
  const raw = Array.isArray(params.game) ? params.game[0] : params.game;
  const game = CARD_GAMES.find((candidate) => candidate === raw) ?? DEFAULT_CARD_GAME;
  // `all`: VIEW ALL from Search while the ALL chip is selected — every game's sets / sealed.
  const allGamesScope = raw === 'all';
  // VIEW ALL on Search's SETS / SEALED lands here with `view`; absent = the landing.
  const rawView = Array.isArray(params.view) ? params.view[0] : params.view;
  const view: GameSetsView = rawView === 'sets' || rawView === 'sealed' ? rawView : 'landing';

  return (
    <GameSetsScreen
      allGamesScope={allGamesScope}
      game={game}
      view={view}
      onClose={() => router.back()}
      onOpenCard={(result) => {
        // Same push the catalog search does — catalog results have no owned
        // context, so warm the default raw lane.
        prefetchCardDetail(spotlightRepository, result.cardId, undefined, result.imageUrl);
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: result.cardId,
            previewId: saveCardDetailPreviewFromCatalogResult(result),
          },
        });
      }}
      onViewAll={(section, selectedGame) => {
        router.push({ pathname: '/catalog/game/[game]', params: { game: selectedGame, view: section } });
      }}
      onSelectExpansion={(expansion, selectedGame) => {
        router.push({
          pathname: '/catalog/expansion/[expansionId]',
          params: {
            expansionId: expansion.id,
            // `set_id` is unique only WITHIN a game, so it travels with the set.
            game: selectedGame,
            name: expansion.name,
          },
        });
      }}
    />
  );
}
