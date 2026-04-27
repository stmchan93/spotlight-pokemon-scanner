import { useRouter } from 'expo-router';

import { DesignSystemCatalogScreen } from '@/features/design-system/screens/design-system-catalog-screen';

export default function DesignSystemRoute() {
  const router = useRouter();

  return <DesignSystemCatalogScreen onBack={() => router.back()} />;
}
