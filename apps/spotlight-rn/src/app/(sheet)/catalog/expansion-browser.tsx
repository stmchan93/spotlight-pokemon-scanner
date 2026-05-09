import { useRouter } from 'expo-router';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';

export default function ExpansionBrowserRoute() {
  const router = useRouter();

  return (
    <ExpansionBrowserScreen
      onClose={() => router.back()}
      onSelectExpansion={(expansion) => {
        router.push({
          pathname: '/catalog/expansion/[expansionId]',
          params: {
            expansionId: expansion.id,
            name: expansion.name,
          },
        });
      }}
    />
  );
}
