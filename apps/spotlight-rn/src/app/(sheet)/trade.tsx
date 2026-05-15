import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { TradeSheet } from '@/features/payments/screens/trade-sheet';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

export default function TradeSheetRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    cardId?: string | string[];
    inbound_card_id?: string | string[];
  }>();
  // Accept both the original `cardId` (from card detail) and the scanner
  // hand-off param `inbound_card_id` (used when the user opens a fresh trade
  // sheet without a card in hand and scans the inbound card afterwards).
  const cardId = firstParam(params.cardId) || firstParam(params.inbound_card_id);

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: true, presentation: 'modal' }} />
      <TradeSheet
        cardId={cardId || undefined}
        onClose={() => router.back()}
        onComplete={() => router.replace('/(tabs)/portfolio')}
        onScanInbound={() => {
          // Push the scanner with a return-mode that tells it to navigate
          // back to this sheet with the confirmed inbound cardId attached
          // instead of opening the card detail screen.
          router.push({
            pathname: '/',
            params: { page: 'scanner', return_mode: 'trade' },
          });
        }}
      />
    </>
  );
}
