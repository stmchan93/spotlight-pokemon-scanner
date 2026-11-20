import { useLocalSearchParams, useRouter } from 'expo-router';

import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { useAppServices } from '@/providers/app-providers';

import ExpansionBrowserRoute from './expansion-browser';

export default function CatalogSearchRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  // The scanner lane takes no part here any more. It is about what the camera
  // is pointed at; typed queries search every game and the browse grid starts
  // by asking which game you want.
  const params = useLocalSearchParams<{
    q?: string | string[];
  }>();
  const initialQuery = Array.isArray(params.q) ? params.q[0] ?? '' : params.q ?? '';

  // Search opens on the set-progress sets list (Figma 6552:1913: game chips,
  // per-set completion, a card search box scoped to the game). Only a search
  // handed in through `q` still lands on the all-games results page.
  if (!initialQuery) {
    return <ExpansionBrowserRoute />;
  }

  return (
    <CatalogSearchScreen
      initialQuery={initialQuery}
      onClose={() => router.back()}
      onOpenCard={(result) => {
        // Catalog results have no owned context → warm the default raw lane.
        prefetchCardDetail(spotlightRepository, result.cardId, undefined, result.imageUrl);
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: result.cardId,
            previewId: saveCardDetailPreviewFromCatalogResult(result),
          },
        });
      }}
      onSelectGame={(game) => {
        // A ROUTE, so the platform's back-swipe returns to the game grid rather
        // than popping this search sheet.
        router.push({ pathname: '/catalog/game/[game]', params: { game } });
      }}
    />
  );
}
