import { useLocalSearchParams, useRouter } from 'expo-router';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { BoothStoriesScreen } from '@/features/events/screens/booth-stories-screen';

/** `/booth-stories?eventId=&vendorId=` — full-screen booth photo stories, opened from a show page. */
export default function BoothStoriesRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ eventId?: string | string[]; vendorId?: string | string[] }>();
  const eventId = (Array.isArray(params.eventId) ? params.eventId[0] : params.eventId) ?? '';
  const vendorId = (Array.isArray(params.vendorId) ? params.vendorId[0] : params.vendorId) ?? '';

  return (
    <>
      <FocusedStatusBar style="light" />
      <BoothStoriesScreen eventId={eventId} onClose={() => router.back()} vendorId={vendorId} />
    </>
  );
}
