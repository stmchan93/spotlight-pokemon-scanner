import { useRouter } from 'expo-router';

import { getUserInitials } from '@/features/auth/auth-models';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { useAuth } from '@/providers/auth-provider';

export default function PortfolioRoute() {
  const router = useRouter();
  const { currentUser } = useAuth();

  return (
    <PortfolioScreen
      accountInitials={currentUser ? getUserInitials(currentUser) : 'AC'}
      onOpenAddCard={() => router.push('/catalog/search')}
      onOpenAccount={() => router.push('/account')}
      onOpenInventory={() => router.push('/inventory')}
      onOpenInventoryEntry={(entryId, cardId) =>
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId,
            entryId,
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
  );
}
