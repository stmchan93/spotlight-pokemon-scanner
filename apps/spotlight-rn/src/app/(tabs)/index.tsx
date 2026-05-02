import { useRouter } from 'expo-router';

import { TopTabsPager } from '@/components/top-tabs-pager';
import { getUserInitials } from '@/features/auth/auth-models';
import { saveCardDetailPreviewFromInventoryEntry } from '@/features/cards/card-detail-preview-session';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { useAuth } from '@/providers/auth-provider';

export default function TabsRoot() {
  const router = useRouter();
  const { currentUser } = useAuth();

  return (
    <TopTabsPager
      portfolioSlot={(
        <PortfolioScreen
          accountInitials={currentUser ? getUserInitials(currentUser) : 'AC'}
          onOpenAddCard={() => router.push('/catalog/search')}
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
          onOpenSalesHistory={() => router.push('/sales-history')}
          onOpenSellSelection={(entryId) =>
            router.push({
              pathname: '/inventory',
              params: {
                mode: 'select',
                ...(entryId ? { selected: entryId } : {}),
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
