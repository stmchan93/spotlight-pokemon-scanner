import { useRouter } from 'expo-router';

import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import { CalendarScreen } from '@/features/meta-feed/screens/calendar-screen';
import { FeedMarketRouteGate } from '@/features/meta-feed/components/feed-market-route-gate';

/** `/calendar` — the Coming up page, pushed from the feed's Coming up block. */
function CalendarRouteContent() {
  const router = useRouter();
  const navigation = useMetaFeedNavigation();

  return <CalendarScreen onBack={() => router.back()} onOpenEvent={navigation.openCalendarEvent} />;
}

export default function CalendarRoute() {
  return (
    <FeedMarketRouteGate>
      <CalendarRouteContent />
    </FeedMarketRouteGate>
  );
}
