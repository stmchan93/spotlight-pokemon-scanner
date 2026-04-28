import { useLocalSearchParams, useRouter } from 'expo-router';

import { saveCardDetailPreviewFromInventoryEntry } from '@/features/cards/card-detail-preview-session';
import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0);
  }

  return value;
}

function listParam(value?: string | string[]) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];

  return [...new Set(
    rawValues
      .flatMap((candidate) => candidate.split(','))
      .map((candidate) => candidate.trim())
      .filter(Boolean),
  )];
}

export default function InventoryRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    mode?: string | string[];
    selected?: string | string[];
  }>();

  const initialSelectedIds = listParam(params.selected);
  const mode = firstParam(params.mode);
  const initialMode = mode === 'select' ? 'select' : 'browse';

  return (
    <InventoryBrowserScreen
      key={`${initialMode}:${initialSelectedIds.join(',')}`}
      initialMode={initialMode}
      initialSelectedIds={initialSelectedIds}
      onBack={() => router.back()}
      onOpenBulkSell={(entryIds) => {
        if (entryIds.length === 0) {
          return;
        }

        router.push({
          pathname: '/sell/batch',
          params: {
            entryIds: entryIds.join(','),
          },
        });
      }}
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
