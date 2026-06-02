import { useRouter } from 'expo-router';

import { saveCardDetailPreviewFromInventoryEntry } from '@/features/cards/card-detail-preview-session';
import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';

export default function InventoryRoute() {
  const router = useRouter();

  return (
    <InventoryBrowserScreen
      onBack={() => router.back()}
      onOpenAddCard={() => router.push('/catalog/search')}
      onOpenEntry={(entry) => {
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
  );
}
