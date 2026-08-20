import { useLocalSearchParams, useRouter } from 'expo-router';

import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { useScannerTargetConfig } from '@/features/scanner/use-scanner-target-config';
import { useAppServices } from '@/providers/app-providers';

export default function CatalogSearchRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  // Only the browse grid is per-game — typing still searches every game's cards
  // (which is why results carry a game tag when they span games).
  const { lane } = useScannerTargetConfig();
  const params = useLocalSearchParams<{
    q?: string | string[];
  }>();
  const initialQuery = Array.isArray(params.q) ? params.q[0] ?? '' : params.q ?? '';

  return (
    <CatalogSearchScreen
      game={lane.game}
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
      onSelectExpansion={(expansion) => {
        router.push({
          pathname: '/catalog/expansion/[expansionId]',
          params: {
            expansionId: expansion.id,
            name: expansion.name,
          },
        });
      }}
    />
  );
}
