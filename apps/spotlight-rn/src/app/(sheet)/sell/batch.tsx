import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { BulkSellScreen } from '@/features/sell/screens/bulk-sell-screen';

function listParam(value?: string | string[]) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];

  return [...new Set(
    rawValues
      .flatMap((candidate) => candidate.split(','))
      .map((candidate) => candidate.trim())
      .filter(Boolean),
  )];
}

export default function BulkSellRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    entryIds?: string | string[];
    entryId?: string | string[];
  }>();

  const entryIds = [...new Set([
    ...listParam(params.entryIds),
    ...listParam(params.entryId),
  ])];

  return (
    <>
      <Stack.Screen
        options={{
          gestureEnabled: false,
        }}
      />

      <BulkSellScreen
        key={entryIds.join(',') || 'empty'}
        entryIds={entryIds}
        onClose={() => router.back()}
        onComplete={() => router.replace('/portfolio')}
      />
    </>
  );
}
