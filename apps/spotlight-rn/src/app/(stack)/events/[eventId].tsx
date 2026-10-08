import { useLocalSearchParams, useRouter } from 'expo-router';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';

/** `/events/[eventId]` — a Spotlight show, pushed from the Events tab. */
export default function EventDetailRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ eventId?: string | string[] }>();
  const eventId = (Array.isArray(params.eventId) ? params.eventId[0] : params.eventId) ?? '';

  return (
    <>
      <FocusedStatusBar style="dark" />
      <EventDetailScreen eventId={eventId} onBack={() => router.back()} />
    </>
  );
}
