import { useLocalSearchParams, useRouter } from 'expo-router';

import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { useAppServices } from '@/providers/app-providers';

export default function CatalogSearchRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const params = useLocalSearchParams<{
    q?: string | string[];
  }>();
  const initialQuery = Array.isArray(params.q) ? params.q[0] ?? '' : params.q ?? '';

  return (
    <CatalogSearchScreen
      initialQuery={initialQuery}
      onClose={() => router.back()}
      onOpenCard={(result) => {
        // Catalog results have no owned context → warm the default raw lane.
        prefetchCardDetail(spotlightRepository, result.cardId);
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: result.cardId,
            previewId: saveCardDetailPreviewFromCatalogResult(result),
          },
        });
      }}
      onOpenExpansionBrowser={() => router.push('/catalog/expansion-browser')}
    />
  );
}
