import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { BuySheet } from '@/features/payments/screens/buy-sheet';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

export default function BuySheetRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ cardId?: string | string[] }>();
  const cardId = firstParam(params.cardId);

  if (!cardId) {
    return null;
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: true, presentation: 'modal' }} />
      <BuySheet
        cardId={cardId}
        onClose={() => router.back()}
        onComplete={() => router.replace('/(tabs)/portfolio')}
      />
    </>
  );
}
