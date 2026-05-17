import { useLocalSearchParams, useRouter } from 'expo-router';

import { QuickSellScreen } from '@/features/sell/screens/quick-sell-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

export default function QuickSellRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ cardId?: string | string[] }>();
  const cardId = firstParam(params.cardId) || undefined;

  return (
    <QuickSellScreen
      initialCardId={cardId}
      onBack={() => router.back()}
      onDone={() => router.back()}
    />
  );
}
