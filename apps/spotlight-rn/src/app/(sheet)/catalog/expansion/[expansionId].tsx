import { useLocalSearchParams, useRouter } from 'expo-router';

import { CARD_GAMES } from '@spotlight/api-client';

import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';
import { useScannerTargetConfig } from '@/features/scanner/use-scanner-target-config';
import { useAppServices } from '@/providers/app-providers';

export default function ExpansionDetailRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  // Fallback only, for a deep link that carries no game. The browser now sends
  // the game the set was listed under — `set_id` is unique only within a game.
  const { lane } = useScannerTargetConfig();
  const params = useLocalSearchParams<{
    expansionId?: string | string[];
    game?: string | string[];
    name?: string | string[];
  }>();

  const expansionId = Array.isArray(params.expansionId) ? params.expansionId[0] ?? '' : params.expansionId ?? '';
  const expansionName = Array.isArray(params.name) ? params.name[0] ?? '' : params.name ?? '';
  const gameParam = Array.isArray(params.game) ? params.game[0] : params.game;
  const game = CARD_GAMES.find((candidate) => candidate === gameParam) ?? lane.game;

  return (
    <ExpansionDetailScreen
      expansionId={expansionId}
      expansionName={expansionName}
      game={game}
      onClose={() => router.back()}
      onOpenCard={(result) => {
        // Warm the detail + default-lane price-trend caches the instant the card
        // is tapped (during the push animation) so the PDP's configurator/ADD
        // ITEM + price trends aren't fetching cold on mount. Mirrors the catalog
        // search route; catalog cards carry no owned context → default raw lane.
        prefetchCardDetail(spotlightRepository, result.cardId, undefined, result.imageUrl);
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: result.cardId,
            previewId: saveCardDetailPreviewFromCatalogResult(result),
          },
        });
      }}
    />
  );
}
