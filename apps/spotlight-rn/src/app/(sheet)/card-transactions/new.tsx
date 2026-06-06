import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { LogTransactionScreen } from '@/features/sales/screens/log-transaction-screen';

export default function LogTransactionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    note?: string | string[];
    imageUrl?: string | string[];
  }>();
  const rawNote = Array.isArray(params.note) ? params.note[0] : params.note;
  const cardLabel = (rawNote ?? '').trim() || undefined;
  const rawImageUrl = Array.isArray(params.imageUrl) ? params.imageUrl[0] : params.imageUrl;
  const cardImageUrl = (rawImageUrl ?? '').trim() || undefined;

  return (
    <>
      <Stack.Screen
        options={{
          gestureEnabled: false,
        }}
      />

      <LogTransactionScreen
        cardImageUrl={cardImageUrl}
        cardLabel={cardLabel}
        onClose={() => router.back()}
        onComplete={() => router.replace('/sales')}
      />
    </>
  );
}
