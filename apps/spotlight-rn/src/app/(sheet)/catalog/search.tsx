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
        prefetchCardDetail(spotlightRepository, result.cardId, undefined, result.imageUrl);
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: result.cardId,
            previewId: saveCardDetailPreviewFromCatalogResult(result),
          },
        });
      }}
      onOpenPerson={(person) => {
        // Route to the person's public profile. Prefer their @handle; fall back
        // to the user id for collectors who haven't claimed a handle — the
        // `/u/[handle]` route detects a UUID slug and resolves it by id.
        const slug = person.handle?.trim() || person.userID;
        router.push({
          pathname: '/u/[handle]',
          params: { handle: slug },
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
