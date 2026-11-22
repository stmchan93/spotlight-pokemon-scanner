import { useRouter } from 'expo-router';

import { VendorSettingsScreen } from '@/features/vendor/screens/vendor-settings-screen';

export default function AccountVendorPricingRoute() {
  const router = useRouter();

  return (
    <VendorSettingsScreen
      onBack={() => {
        router.back();
      }}
    />
  );
}
