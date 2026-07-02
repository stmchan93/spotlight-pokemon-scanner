import { useLocalSearchParams, useRouter } from 'expo-router';

import { TopTabsPager } from '@/components/top-tabs-pager';
import {
  cardDetailPreviewFromInventoryEntry,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  defaultLaneFromPreview,
  prefetchCardDetail,
} from '@/features/cards/card-detail-prefetch';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { useAppServices } from '@/providers/app-providers';

export default function TabsRoot() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const params = useLocalSearchParams<{
    page?: 'portfolio' | 'scanner' | string | string[];
  }>();
  const requestedPage = Array.isArray(params.page) ? params.page[0] : params.page;
  // Collection is the landing tab (first thing after login); the scanner only
  // opens when explicitly requested (`/scan` redirects here with page=scanner).
  const initialPage = requestedPage === 'scanner' ? 'scanner' : 'portfolio';

  return (
    <TopTabsPager
      initialPage={initialPage}
      portfolioSlot={(
        <PortfolioScreen
          onOpenInventoryEntry={(entry) => {
            // Warm the PDP caches with this card's default lane (graded if the
            // entry is a slab, else raw/owned-variant) + hero image before
            // navigation.
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
      )}
      renderScannerSlot={(onExitToPortfolio, onTopLevelSwipeEnabledChange) => (
        <ScannerScreen
          onExitToPortfolio={onExitToPortfolio}
          onTopLevelSwipeEnabledChange={onTopLevelSwipeEnabledChange}
        />
      )}
    />
  );
}
