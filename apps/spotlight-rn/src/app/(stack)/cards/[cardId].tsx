import { useLocalSearchParams, useRouter } from 'expo-router';

import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }

  return value ?? '';
}

export default function CardDetailRoute() {
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
    <CardDetailScreen
      key={`${cardId}:${entryId ?? ''}`}
      cardId={cardId}
      entryId={entryId}
      onBack={() => router.back()}
      onOpenAddToCollection={(nextCardId, nextEntryId) => {
        router.push({
          pathname: '/collection/add/[cardId]',
          params: {
            cardId: nextCardId,
            entryId: nextEntryId,
          },
        });
      }}
      onOpenSell={(selectedEntryId) => {
        router.push({
          pathname: '/sell/[entryId]',
          params: {
            entryId: selectedEntryId,
          },
        });
      }}
    />
  );
}
