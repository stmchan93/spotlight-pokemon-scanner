import { useRouter } from 'expo-router';

import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';

export default function CatalogSearchRoute() {
  const router = useRouter();

  return (
    <CatalogSearchScreen
      onClose={() => router.back()}
      onOpenCard={(cardId) => {
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId,
          },
        });
      }}
    />
  );
}
