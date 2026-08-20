import { useRouter } from 'expo-router';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { useScannerTargetConfig } from '@/features/scanner/use-scanner-target-config';

export default function ExpansionBrowserRoute() {
  const router = useRouter();
  // The persisted scanner lane is the app's single "which game am I in"
  // selection, so browsing sets follows it rather than pinning Pokémon.
  const { lane } = useScannerTargetConfig();

  return (
    <ExpansionBrowserScreen
      game={lane.game}
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
