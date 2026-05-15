import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { SellStripeSheet } from '@/features/payments/screens/sell-stripe-sheet';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

export default function SellStripeSheetRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ entryId?: string | string[] }>();
  const entryId = firstParam(params.entryId);

  if (!entryId) {
    return null;
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: true, presentation: 'modal' }} />
      <SellStripeSheet
        entryId={entryId}
        onClose={() => router.back()}
        onOrderCreated={(orderId) => {
          router.replace({
            pathname: '/sell-stripe-qr',
            params: { orderId },
          });
        }}
      />
    </>
  );
}
