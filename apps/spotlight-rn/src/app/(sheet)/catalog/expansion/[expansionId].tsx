import { useLocalSearchParams, useRouter } from 'expo-router';

import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';

export default function ExpansionDetailRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    expansionId?: string | string[];
    name?: string | string[];
  }>();

  const expansionId = Array.isArray(params.expansionId) ? params.expansionId[0] ?? '' : params.expansionId ?? '';
  const expansionName = Array.isArray(params.name) ? params.name[0] ?? '' : params.name ?? '';

  return (
    <ExpansionDetailScreen
      expansionId={expansionId}
      expansionName={expansionName}
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
