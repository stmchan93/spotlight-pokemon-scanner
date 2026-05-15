import { useLocalSearchParams, useRouter } from 'expo-router';

import { TopTabsPager } from '@/components/top-tabs-pager';
import { getUserInitials } from '@/features/auth/auth-models';
import { saveCardDetailPreviewFromInventoryEntry } from '@/features/cards/card-detail-preview-session';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { useAuth } from '@/providers/auth-provider';

export default function TabsRoot() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    page?: 'portfolio' | 'scanner' | string | string[];
    return_mode?: 'trade' | string | string[];
  }>();
  const { currentUser } = useAuth();
  const requestedPage = Array.isArray(params.page) ? params.page[0] : params.page;
  const initialPage = requestedPage === 'portfolio' ? 'portfolio' : 'scanner';
  const requestedReturnMode = Array.isArray(params.return_mode)
    ? params.return_mode[0]
    : params.return_mode;
  const returnMode = requestedReturnMode === 'trade' ? 'trade' : undefined;

  return (
    <TopTabsPager
      initialPage={initialPage}
      portfolioSlot={(
        <PortfolioScreen
          accountInitials={currentUser ? getUserInitials(currentUser) : 'AC'}
          onOpenAccount={() => router.push('/account')}
          onOpenInventory={() => router.push('/inventory')}
          onOpenInventoryEntry={(entry) =>
            router.push({
              pathname: '/cards/[cardId]',
              params: {
                cardId: entry.cardId,
                entryId: entry.id,
                previewId: saveCardDetailPreviewFromInventoryEntry(entry),
              },
            })}
          onOpenCardDetail={(cardId) =>
            router.push({
              pathname: '/cards/[cardId]',
              params: { cardId },
            })}
          onOpenSalesHistory={() => router.push('/sales')}
        />
      )}
      renderScannerSlot={(onExitToPortfolio, onTopLevelSwipeEnabledChange) => (
        <ScannerScreen
          onExitToPortfolio={onExitToPortfolio}
          onTopLevelSwipeEnabledChange={onTopLevelSwipeEnabledChange}
          returnMode={returnMode}
        />
      )}
    />
  );
}
