import { useRouter } from 'expo-router';

import { ShowSummaryScreen } from '@/features/analytics/screens/show-summary-screen';

export default function ShowSummaryRoute() {
  const router = useRouter();
  return <ShowSummaryScreen onBack={() => router.back()} />;
}
