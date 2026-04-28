import { useRouter } from 'expo-router';

import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';

export default function CatalogSearchRoute() {
  const router = useRouter();

  return (
    <CatalogSearchScreen
      onClose={() => router.back()}
      onOpenCard={(result) => {
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
