import { useRouter } from 'expo-router';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';

export default function ExpansionBrowserRoute() {
  const router = useRouter();

  return (
    <ExpansionBrowserScreen
      onClose={() => router.back()}
      onSelectGame={(game) => {
        router.push({ pathname: '/catalog/game/[game]', params: { game } });
      }}
    />
  );
}
