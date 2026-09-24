import { useRouter } from 'expo-router';

import { AlertSettingsScreen } from '@/features/notifications/screens/alert-settings-screen';

export default function AccountAlertsRoute() {
  const router = useRouter();

  return (
    <AlertSettingsScreen
      onBack={() => {
        router.back();
      }}
    />
  );
}
