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
  }>();

  const entryId = firstParam(params.entryId);

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
        key={entryId}
        entryId={entryId}
        onClose={() => router.back()}
        onComplete={() => router.replace('/portfolio')}
      />
    </>
  );
}
