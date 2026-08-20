import { useLocalSearchParams, useRouter } from 'expo-router';

import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';
import { useScannerTargetConfig } from '@/features/scanner/use-scanner-target-config';
import { useAppServices } from '@/providers/app-providers';

export default function ExpansionDetailRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  // Same lane the browser listed this set under — `set_id` is only unique
  // within a game, so drilling in has to carry it.
  const { lane } = useScannerTargetConfig();
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
      game={lane.game}
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
