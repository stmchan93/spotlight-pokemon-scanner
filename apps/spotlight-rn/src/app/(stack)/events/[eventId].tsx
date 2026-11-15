import { useLocalSearchParams, useRouter } from 'expo-router';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';

/** `/events/[eventId]` — a Spotlight show, pushed from the Events tab or a deep link. */
export default function EventDetailRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ eventId?: string | string[]; vendor?: string | string[] }>();
  const eventId = (Array.isArray(params.eventId) ? params.eventId[0] : params.eventId) ?? '';
  // `/events/<eventId>?vendor=<vendorId>` opens with that vendor selected (vendor email links).
  const vendorId = (Array.isArray(params.vendor) ? params.vendor[0] : params.vendor) || null;

  return (
    <>
      <FocusedStatusBar style="dark" />
      <EventDetailScreen eventId={eventId} initialVendorId={vendorId} onBack={() => router.back()} />
    </>
  );
}
