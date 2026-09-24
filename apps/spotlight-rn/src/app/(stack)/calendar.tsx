import { useRouter } from 'expo-router';

import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import { CalendarScreen } from '@/features/meta-feed/screens/calendar-screen';

/** `/calendar` — the Coming up page, pushed from the feed's Coming up block. */
export default function CalendarRoute() {
  const router = useRouter();
  const navigation = useMetaFeedNavigation();

  return <CalendarScreen onBack={() => router.back()} onOpenEvent={navigation.openCalendarEvent} />;
}
