import { useRouter } from 'expo-router';

import { LatestSalesScreen } from '@/features/sales/screens/latest-sales-screen';

export default function LatestSalesRoute() {
  const router = useRouter();

  return <LatestSalesScreen onBack={() => router.back()} />;
}
