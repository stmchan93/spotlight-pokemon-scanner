import { useLocalSearchParams, useRouter } from 'expo-router';

import { TopTabsPager } from '@/components/top-tabs-pager';
import { saveCardDetailPreviewFromInventoryEntry } from '@/features/cards/card-detail-preview-session';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

export default function TabsRoot() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    page?: 'portfolio' | 'scanner' | string | string[];
  }>();
  const requestedPage = Array.isArray(params.page) ? params.page[0] : params.page;
  const initialPage = requestedPage === 'portfolio' ? 'portfolio' : 'scanner';

  return (
    <TopTabsPager
      initialPage={initialPage}
      portfolioSlot={(
        <PortfolioScreen
          onOpenInventoryEntry={(entry) =>
            router.push({
              pathname: '/cards/[cardId]',
              params: {
                cardId: entry.cardId,
                entryId: entry.id,
                previewId: saveCardDetailPreviewFromInventoryEntry(entry),
              },
            })}
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
