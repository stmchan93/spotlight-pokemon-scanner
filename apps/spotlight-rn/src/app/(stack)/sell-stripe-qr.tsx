import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { SellStripeQrScreen } from '@/features/payments/screens/sell-stripe-qr-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

export default function SellStripeQrRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ orderId?: string | string[] }>();
  const orderId = firstParam(params.orderId);

  if (!orderId) {
    return null;
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <SellStripeQrScreen
        onClose={() => router.back()}
        onDone={() => router.replace('/(tabs)/portfolio')}
        orderId={orderId}
      />
    </>
  );
}
