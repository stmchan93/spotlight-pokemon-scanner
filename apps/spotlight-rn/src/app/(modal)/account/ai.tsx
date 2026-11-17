import { useRouter } from 'expo-router';

import { UseWithAiScreen } from '@/features/ai-settings/screens/use-with-ai-screen';

export default function AccountUseWithAiRoute() {
  const router = useRouter();

  return (
    <UseWithAiScreen
      onBack={() => {
        router.back();
      }}
    />
  );
}
