import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { LogTransactionScreen } from '@/features/sales/screens/log-transaction-screen';

export default function LogTransactionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ note?: string | string[] }>();
  const rawNote = Array.isArray(params.note) ? params.note[0] : params.note;
  const cardLabel = (rawNote ?? '').trim() || undefined;

  return (
    <>
      <Stack.Screen
        options={{
          gestureEnabled: false,
        }}
      />

      <LogTransactionScreen
        cardLabel={cardLabel}
        onClose={() => router.back()}
        onComplete={() => router.replace('/sales')}
      />
    </>
  );
}
