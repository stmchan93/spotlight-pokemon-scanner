import { Stack, useRouter } from 'expo-router';

import { LogTransactionScreen } from '@/features/sales/screens/log-transaction-screen';

export default function LogTransactionRoute() {
  const router = useRouter();

  return (
    <>
      <Stack.Screen
        options={{
          gestureEnabled: false,
        }}
      />

      <LogTransactionScreen
        onClose={() => router.back()}
        onComplete={() => router.replace('/sales')}
      />
    </>
  );
}
