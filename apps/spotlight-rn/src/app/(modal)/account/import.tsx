import { useRouter } from 'expo-router';

import { PortfolioImportScreen } from '@/features/portfolio-import/screens/portfolio-import-screen';

export default function AccountImportRoute() {
  const router = useRouter();

  return (
    <PortfolioImportScreen
      onClose={() => {
        router.back();
      }}
    />
  );
}
