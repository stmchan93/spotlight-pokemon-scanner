import { useRouter } from 'expo-router';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import {
  cardDetailPreviewFromInventoryEntry,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  defaultLaneFromPreview,
  prefetchCardDetail,
} from '@/features/cards/card-detail-prefetch';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { useAppServices } from '@/providers/app-providers';

/**
 * Collection as a native tab.
 *
 * The PDP prefetch-and-push wiring is copied verbatim from `(tabs)/index.tsx`:
 * if this screen behaves differently from the live one, the difference has to be
 * the navigation shell and nothing else, or the comparison proves nothing.
 */
export default function NativeTabsCollection() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();

  return (
    <NativeTabsPageBridge page="portfolio">
        <PortfolioScreen
          onOpenInventoryEntry={(entry) => {
            const preview = cardDetailPreviewFromInventoryEntry(entry);
            prefetchCardDetail(
              spotlightRepository,
              entry.cardId,
              defaultLaneFromPreview(preview),
              preview.largeImageUrl ?? preview.imageUrl,
            );
            router.push({
              pathname: '/cards/[cardId]',
              params: {
                cardId: entry.cardId,
                entryId: entry.id,
                previewId: saveCardDetailPreviewFromInventoryEntry(entry),
              },
            });
          }}
        />

    </NativeTabsPageBridge>
  );
}

