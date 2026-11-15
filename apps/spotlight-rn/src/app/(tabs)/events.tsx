import { FocusedStatusBar } from '@/components/focused-status-bar';
import { EventsScreen } from '@/features/events/screens/events-screen';

/**
 * Events — upcoming card shows, the fourth tab in the bar.
 */
export default function EventsRoute() {
  return (
    <>
      {/* Light: the screen opens on a dark photo header. */}
      <FocusedStatusBar style="light" />
      <EventsScreen />
    </>
  );
}
