import { useRouter } from 'expo-router';

import { VendorBoughtScreen } from '@/features/vendor/screens/vendor-bought-screen';

export default function AccountBoughtRoute() {
  const router = useRouter();

  return (
    <VendorBoughtScreen
      onBack={() => {
        router.back();
      }}
    />
  );
}
