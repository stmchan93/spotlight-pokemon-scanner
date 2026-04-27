import { useLocalSearchParams, useRouter } from 'expo-router';

import { AddToCollectionScreen } from '@/features/collection/screens/add-to-collection-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }

  return value ?? '';
}

export default function AddToCollectionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    cardId?: string | string[];
    entryId?: string | string[];
  }>();
  const cardId = firstParam(params.cardId);
  const entryId = firstParam(params.entryId) || undefined;

  if (!cardId) {
    return null;
  }

  return (
    <AddToCollectionScreen
      key={`${cardId}:${entryId ?? ''}`}
      cardId={cardId}
      entryId={entryId}
      onClose={() => router.back()}
    />
  );
}
