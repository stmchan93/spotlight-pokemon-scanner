import { useRouter } from 'expo-router';

import { SalesHistoryScreen } from '@/features/portfolio/screens/sales-history-screen';

export default function SalesHistoryRoute() {
  const router = useRouter();

  return <SalesHistoryScreen onBack={() => router.back()} />;
}
