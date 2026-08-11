import { useRouter } from 'expo-router';

import { BlockedAccountsScreen } from '@/features/social/screens/blocked-accounts-screen';

export default function AccountBlockedRoute() {
  const router = useRouter();

  return (
    <BlockedAccountsScreen
      onBack={() => {
        router.back();
      }}
    />
  );
}
