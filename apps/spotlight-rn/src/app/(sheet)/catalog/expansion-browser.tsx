import { useRouter } from 'expo-router';

import { assistantHref } from '@/features/assistant/assistant-route';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { useAppServices } from '@/providers/app-providers';

export default function ExpansionBrowserRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();

  return (
    <ExpansionBrowserScreen
      onClose={() => router.back()}
      onOpenAssistant={() => router.push(assistantHref('home'))}
      onOpenCard={(result) => {
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
        // A pushed route, so back-swipe returns to the landing.
        router.push({ pathname: '/catalog/game/[game]', params: { game: selectedGame, view: section } });
      }}
      onSelectExpansion={(expansion, selectedGame) => {
        router.push({
          pathname: '/catalog/expansion/[expansionId]',
          params: { expansionId: expansion.id, game: selectedGame, name: expansion.name },
        });
      }}
    />
  );
}
