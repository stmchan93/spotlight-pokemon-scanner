import { FocusedStatusBar } from '@/components/focused-status-bar';
import { MountOnFirstFocus } from '@/components/mount-on-first-focus';
import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { EventsScreen } from '@/features/events/screens/events-screen';

/**
 * Events — upcoming card shows, the fourth tab in the bar.
 *
 * Bridged as 'portfolio' for the same reason as Wishlist and Social:
 * `activePage` only distinguishes "the scanner is live" from "it isn't".
 */
export default function EventsRoute() {
  return (
    <NativeTabsPageBridge page="portfolio">
      {/* Light: the screen opens on a dark photo header. */}
      <FocusedStatusBar style="light" />
      <MountOnFirstFocus>
        <EventsScreen />
      </MountOnFirstFocus>
    </NativeTabsPageBridge>
  );
}
