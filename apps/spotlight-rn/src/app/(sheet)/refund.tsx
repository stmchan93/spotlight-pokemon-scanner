import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { RefundSheet } from '@/features/payments/screens/refund-sheet';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

function parseAmount(value?: string | string[]) {
  const raw = firstParam(value);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export default function RefundSheetRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    orderId?: string | string[];
    cardName?: string | string[];
    soldAmount?: string | string[];
    currencyCode?: string | string[];
    alreadyRefunded?: string | string[];
  }>();
  const orderId = firstParam(params.orderId);
  const cardName = firstParam(params.cardName);
  const soldAmount = parseAmount(params.soldAmount);
  const currencyCode = firstParam(params.currencyCode) || 'USD';
  const alreadyRefunded = firstParam(params.alreadyRefunded) === '1';

  if (!orderId) {
    return null;
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: true, presentation: 'modal' }} />
      <RefundSheet
        alreadyRefunded={alreadyRefunded}
        cardName={cardName || null}
        currencyCode={currencyCode}
        onClose={() => router.back()}
        onRefundCompleted={() => {
          router.back();
        }}
        orderId={orderId}
        soldAmount={soldAmount}
      />
    </>
  );
}
