import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { SingleSellScreen } from '@/features/sell/screens/single-sell-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }

  return value ?? '';
}

export default function SingleSellRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    entryId?: string | string[];
    cardId?: string | string[];
    fromScan?: string | string[];
  }>();

  const entryId = firstParam(params.entryId);
  const cardId = firstParam(params.cardId) || undefined;
  const fromScan = firstParam(params.fromScan) === '1';

  if (!entryId) {
    return null;
  }

  return (
    <>
      <Stack.Screen
        options={{
          gestureEnabled: false,
        }}
      />

      <SingleSellScreen
        key={`${entryId}:${cardId ?? ''}:${fromScan ? '1' : '0'}`}
        cardId={cardId}
        entryId={entryId}
        fromScan={fromScan}
        onClose={() => router.back()}
        onComplete={() => router.replace('/portfolio')}
      />
    </>
  );
}
